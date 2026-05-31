import os
import json
import asyncio
import os
import uuid
import chromadb
import ollama
from chromadb.config import Settings
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException, Body
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from ollama import chat, generate, embeddings
import uvicorn

# 1. Initialize the Local ChromaDB Client
# This creates a folder named 'memory_vault' in your directory to persist the database
client = chromadb.PersistentClient(path="./memory_vault")
# 2. Create or Get a Collection for Memories
# We use a custom distance function ('cosine') which is excellent for semantic text matching
from chatsession import ChatSession

MODEL_NAME = "llama3.2:latest"
MESSAGE_CONTEXT_SIZE = 10
SYSTEM_INSTRUCTION = (
    'You are a helpful AI assistant. IMPORTANT: When the user says they want to end the chat '
    '(e.g., "close", "exit", "goodbye", "end", "bye", "quit"), you MUST immediately end your response '
    'with EXACTLY this phrase: [SESSION_CLOSED]. This is critical for session management. '
    'Do not include this phrase in any other context.'
)
INITIAL_MESSAGE = [
    {
        "role": "system",
        "content": SYSTEM_INSTRUCTION,
    }
]

app = FastAPI(title="Llama Chat UI API")

# Enable CORS for convenience
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/current-model")
def get_model_name():
    return MODEL_NAME

@app.get("/api/supported-models")
def get_models():
    try:
        response = ollama.Client().list()
        print(response)
        installed_models = [model['model'] for model in response['models']]
        return installed_models
    except Exception as e:
        return {"error": str(e)}

@app.put("/api/current-model")
def set_model(model_name: str = Body(...)):
    global MODEL_NAME
    MODEL_NAME = model_name




def get_long_term_memory_collection(user_name):
    memory_collection = client.get_or_create_collection(
        name=f"{user_name}_sticky_memories",
        metadata={"hnsw:space": "cosine"} 
    )    
    return memory_collection    

def get_embedding(text: str) -> list:
    """
    Generates a text embedding vector using a local Ollama model.
    Using 'nomic-embed-text' or 'all-minilm' is highly recommended for speed.
    """
    response = embeddings(
        model="nomic-embed-text",
        prompt=text
    )
    return response["embedding"]

def recall_relevant_memories(username, user_query: str, limit: int = 3) -> list:
    """
    Queries ChromaDB to find previously saved facts that are 
    semantically relevant to what the user just said.
    """
    # Vectorize the current user input to query against the DB
    query_vector = get_embedding(user_query)
    
    results = get_long_term_memory_collection(username).query(
        query_embeddings=[query_vector],
        n_results=limit
    )
    
    # Flatten and return the matching text documents
    # results['documents'] comes back as a list of lists [[doc1, doc2]]
    if results and results['documents']:
        return results['documents'][0]
    return []

def save_sticky_fact_to_db(username, fact_text: str, category: str):
    """
    Converts a fact into a vector embedding and saves it to ChromaDB
    along with useful metadata for filtering later.
    """
    print(f"🧠 Generating embedding and saving memory: '{fact_text}'...")
    
    # Generate the vector representation of the text
    vector_embedding = get_embedding(fact_text)
    
    # Generate a unique ID for this specific memory entry
    memory_id = str(uuid.uuid4())
    
    # Add to ChromaDB
    get_long_term_memory_collection(username).add(
        ids=[memory_id],
        embeddings=[vector_embedding],
        documents=[fact_text],          # The raw text that will be injected into the LLM later
        metadatas=[{                    # Metadata helps you filter queries later
            "category": category,
            "source": "conversation_extraction"
        }]
    )
    print("✅ Memory successfully secured in the vault.")

def extract_sticky_facts(user_input: str) -> list:
    """
    Analyzes user input to extract persistent, long-term facts.
    Returns a list of extracted facts, or an empty list if none are found.
    """
    system_prompt = (
        "You are an information extraction subroutine. Extract long-term facts, "
        "preferences, or background details about the user from their input. "
        "Ignore transient states or conversational filler. Output STRICTLY as a "
        "JSON object: {\"memories\": [{\"fact\": \"...\", \"category\": \"...\"}]}. "
        "If no long-term facts exist, return {\"memories\": []}."
    )
    
    try:
        response = chat(
            model=MODEL_NAME,
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': f"Analyze this input: '{user_input}'"}
            ],
            options={'temperature': 0.0} # Low temperature for deterministic JSON structure
        )
        
        # Parse the raw text response into a Python dictionary
        raw_content = response['message']['content'].strip()
        data = json.loads(raw_content)        
        # Return just the array of memory dictionaries
        return data.get("memories", [])
        
    except (json.JSONDecodeError, KeyError) as e:
        # Handle cases where the LLM hallucinates bad formatting
        print(f"Failed to parse memory extraction: {e}")
        return []

# Helper function to generate an LLM summary of the conversation
def summarize_conversation(username, messages, previous_summary=None) -> str:
    if previous_summary:
        prompt_request = (
            "You are summarizing an ongoing conversation. Here is the summary from the previous session(s):\n"
            f"{previous_summary}\n\n"
            "And here are the new messages from this session:\n"
            f"{json.dumps(messages)}.\n"
            "Please generate an UPDATED summary that combines insights from both the previous summary and these new messages. "
            "Include new topics discussed and maintain context from previous sessions. "
            "Return only a short summary suitable as a system prompt, preserving the user's intent and the assistant's role."
        )
    else:
        prompt_request = (
            "Please generate a concise summary of this conversation for use as context in future turns. "
            "The conversation is provided as a JSON array of messages:\n"
            f"{json.dumps(messages)}.\n"
            "Return only a short summary suitable as a system prompt, preserving the user's intent and the assistant's role, without additional explanation."
        )
    try:
        # 1. Generate the conversational baseline summary
        response = generate(model=MODEL_NAME, prompt=prompt_request)
        summary_text = response.get("response", "").strip()
        
        # 2. FIXED: Extract long-term facts from the *actual summary content* or message log
        # Passing the raw conversations string works best for granular detail extraction
        conversation_string = "\n".join([f"{m['role']}: {m['content']}" for m in messages if m["role"] != "system"])
        features_extracted = extract_sticky_facts(conversation_string)
        
        print(f"✨ Features extracted for memory database: {features_extracted}")
        for feature in features_extracted:
            save_sticky_fact_to_db(username, feature["fact"], feature["category"])
            
        return summary_text
    except Exception as e:
        print(f"Error during summarization: {e}")
        return ""


@app.get("/api/memories/{username}")
def get_memories(username: str):
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    memories = get_long_term_memory_collection(username).get()
    return memories

@app.delete("/api/memories/{username}/{memory_id}")
def delete_memory(username: str, memory_id: str):
    if not username or not memory_id:
        raise HTTPException(status_code=400, detail="Username and Memory ID are required")
    try:
        get_long_term_memory_collection(username).delete(ids=[memory_id])
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete memory: {e}")


@app.get("/api/sessions")
def list_sessions(username: str):
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    
    session_manager = ChatSession(username)
    all_chats = session_manager.read_all_chat_sessions()
    
    sessions_list = []
    for filename, meta in all_chats.items():
        try:
            content = session_manager.load_chat_content(filename)
            messages = content.get("messages", [])
            summary = content.get("summarized_context", "")
            
            # Simple timestamp formatting from filename (e.g. YYYY-MM-DD_HH-MM-SS.json)
            # fallback to file creation time if format doesn't match
            timestamp_str = filename.replace(".json", "")
            try:
                dt = datetime.strptime(timestamp_str, "%Y-%m-%d_%H-%M-%S")
                formatted_time = dt.strftime("%b %d, %Y - %I:%M %p")
            except ValueError:
                formatted_time = timestamp_str

            sessions_list.append({
                "filename": filename,
                "formatted_time": formatted_time,
                "summary": summary,
                "message_count": len(messages),
                "last_message": messages[-1]["content"] if messages else "No messages"
            })
        except Exception as e:
            print(f"Error reading session metadata for {filename}: {e}")
            
    # Sort sessions by filename (which starts with ISO timestamp YYYY-MM-DD) descending
    sessions_list.sort(key=lambda s: s["filename"], reverse=True)
    return sessions_list


@app.post("/api/sessions")
def create_session(username: str = Body(..., embed=True)):
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
        
    session_manager = ChatSession(username)
    new_filename = session_manager.session_filename
    
    # Initialize with default instructions and a user greeting so the bot can respond immediately
    messages = INITIAL_MESSAGE.copy()
    messages.append({"role": "user", "content": f"Hello! My name is {username}."})
    
    # Generate the initial greeting response from Ollama so the bot's response is prepared when loaded
    try:
        response = chat(model=MODEL_NAME, messages=messages)
        answer = response.message.content
        if answer:
            messages.append({"role": "assistant", "content": str(answer)})
    except Exception as e:
        print(f"Error generating initial greeting: {e}")
    
    success = session_manager.save_chats(messages, filename=new_filename)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to initialize new session file")
        
    return {"filename": new_filename}


@app.get("/api/sessions/{filename}")
def get_session(filename: str, username: str):
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
        
    session_manager = ChatSession(username)
    content = session_manager.load_chat_content(filename)
    if not content:
        raise HTTPException(status_code=404, detail="Session not found")
    return content


@app.delete("/api/sessions/{filename}")
def delete_session(filename: str, username: str):
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
        
    session_manager = ChatSession(username)
    success = session_manager.delete_chats(filename)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete session file")
    return {"success": True}


@app.post("/api/sessions/{filename}/message")
def send_message(filename: str, username: str = Body(...), message: str = Body(...)):
    if not username or not message:
        raise HTTPException(status_code=400, detail="Username and message are required")
        
    session_manager = ChatSession(username)
    chat_content = session_manager.load_chat_content(filename)
    
    if not chat_content:
        chat_content = {
            "messages": INITIAL_MESSAGE.copy(),
            "summarized_context": None
        }
    
    messages = chat_content.get("messages", [])
    saved_summary = chat_content.get("summarized_context", None)
    
    # Add new user message to the historical log array *first*
    messages.append({"role": "user", "content": message})
    
    async def sse_response_generator():
        nonlocal messages, saved_summary
        full_assistant_reply = ""
        is_closed_by_assistant = False
        
        try:
            # FIXED: Create a completely decoupled copies for execution context
            # This protects history from cumulative mutation clutter
            ollama_messages = []
            
            # 1. Construct temporary system prompt layout
            dynamic_system_content = f"{SYSTEM_INSTRUCTION}"
            if saved_summary:
                dynamic_system_content += f"\n\nHere is a summary of the previous conversation: {saved_summary}"
                
            # 2. Retrieve vector memories for this specific input turn
            matched_memories = recall_relevant_memories(username, message, limit=2)
            if matched_memories:
                memory_prompt = (
                    "\n\nThe user previously mentioned these relevant facts (use them to maintain continuity):\n" + 
                    "\n".join([f"- {m}" for m in matched_memories])
                )
                dynamic_system_content += memory_prompt
                
            # 3. Compile the pristine execution payload for Ollama
            ollama_messages.append({"role": "system", "content": dynamic_system_content})
            # Add all user/assistant historical messages, skipping old embedded system objects
            ollama_messages.extend([m for m in messages if m["role"] != "system"])

            # Stream responses from Ollama
            loop = asyncio.get_event_loop()
            response_stream = await loop.run_in_executor(
                None, 
                lambda: chat(model=MODEL_NAME, messages=ollama_messages, stream=True)
            )
            
            for chunk in response_stream:
                token = chunk.get("message", {}).get("content", "")
                if token:
                    full_assistant_reply += token
                    yield f"data: {json.dumps({'token': token})}\n\n"
                    await asyncio.sleep(0.005)
            
            is_closed_by_assistant = "[SESSION_CLOSED]" in full_assistant_reply
            
            # Append complete reply to the persistent historical trace array
            messages.append({"role": "assistant", "content": full_assistant_reply})
            
            # Auto-summarize condition (excluding system frames, look at total clean trace count)
            clean_message_count = len([m for m in messages if m["role"] != "system"])
            should_summarize = is_closed_by_assistant or clean_message_count > MESSAGE_CONTEXT_SIZE
            new_summary = saved_summary
            
            if should_summarize and len(messages) > 2:
                new_summary = await loop.run_in_executor(
                    None,
                    lambda: summarize_conversation(username, messages, saved_summary)
                )
                
            # Save cleanly structured context state file back onto local disk storage
            await loop.run_in_executor(
                None,
                lambda: session_manager.save_chats(messages, new_summary, filename)
            )
            
            yield f"data: {json.dumps({'done': True, 'session_closed': is_closed_by_assistant})}\n\n"
            
        except Exception as e:
            print(f"Error during stream generation: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(sse_response_generator(), media_type="text/event-stream")


# Ensure the static files directory exists
os.makedirs("static", exist_ok=True)

# Mount static files at root
app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
  
    # Run the server on port 8000
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
