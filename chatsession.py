



import os
import json
from datetime import datetime

BASE_CHAT_DIR = os.path.join(os.path.dirname(__file__), "chats")


class ChatSession:
    def __init__(self, username):
        self.username = username
        self.chatlocation = os.path.join(BASE_CHAT_DIR, username)
        os.makedirs(self.chatlocation, exist_ok=True)
        self.session_filename = self._generate_new_session_filename()

    def _get_full_path(self, filename):
        return os.path.join(self.chatlocation, filename)

    def read_all_chat_sessions(self):
        """
        Returns a mapping of saved JSON chat sessions for this user.

        Each JSON file found in the user's chat directory is returned as a
        filename->metadata entry with filename and path.
        """
        all_chats = {}
        if not os.path.exists(self.chatlocation):
            print(f"Chat directory not found: {self.chatlocation}")
            return all_chats
        
        if not os.path.isdir(self.chatlocation):
            print(f"Chat location is not a directory: {self.chatlocation}")
            return all_chats

        for filename in os.listdir(self.chatlocation):
            if filename.endswith(".json"): # Ensure we only process JSON files
                filepath = self._get_full_path(filename) # Use the helper to get the full path
                all_chats[filename] = {"filename": filename, "path": filepath} # Only store filename and path
        return all_chats # Return the list of chat metadata


    def load_chat_content(self, filename) -> dict:
        """
        Load and parse the JSON content of a saved chat file.

        Args:
            filename (str): The name of the chat JSON file.

        Returns:
            dict: The parsed JSON data, or an empty dict if the file cannot be read.
        """
        filepath = self._get_full_path(filename)
        chat_data = {}
        if not os.path.exists(filepath):
            print(f"File not found: {filepath}")
            return chat_data
        
        if not filepath.endswith(".json"):
            print(f"File is not a JSON file: {filepath}")
            return chat_data

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                chat_data = json.load(f)
                return chat_data
        except json.JSONDecodeError:
            print(f"Error decoding JSON from file: {filepath}")
            return chat_data
        except Exception as e:
            print(f"Error reading file {filepath}: {e}")
            return chat_data


    def _generate_new_session_filename(self):
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = f"{timestamp}.json"
        return filename


    def save_chats(self, messages, summarized_context=None, filename=None):
        """Save the current session messages and optional summary to disk."""
        target_filename = filename if filename else self.session_filename
        filepath = self._get_full_path(target_filename)
        data_to_save = {
            "messages": messages,
            "summarized_context": summarized_context if summarized_context else None
        }
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data_to_save, f, indent=4)
            return True
        except Exception as e:
            print(f"Error saving chat to {filepath}: {e}")
            return False

    def delete_chats(self, filename):
        """Delete a chat session file from disk."""
        filepath = self._get_full_path(filename)
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
                return True
            except Exception as e:
                print(f"Error deleting file {filepath}: {e}")
                return False
        return False

        