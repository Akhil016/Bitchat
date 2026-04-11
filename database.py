import os
from pymongo import MongoClient
from werkzeug.security import generate_password_hash, check_password_hash
from bson import ObjectId

# Use environment variables for production security
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/")
client = MongoClient("mongodb+srv://bitchat:bitchat123@typo.xm9vj.mongodb.net/")
db = client['BitChatDB']

class User:
    def __init__(self, user_data):
        self.id = str(user_data['_id'])
        self.username = user_data['username']

    def is_authenticated(self): return True
    def is_active(self): return True
    def is_anonymous(self): return False
    def get_id(self): return self.id

def create_user(username, password):
    if db.users.find_one({'username': username}):
        return False
    hash_pw = generate_password_hash(password)
    db.users.insert_one({
        'username': username, 
        'password': hash_pw, 
        'online': False, 
        'sid': None,
        'public_key': None
    })
    return True

def verify_user(username, password):
    user = db.users.find_one({'username': username})
    if user and check_password_hash(user['password'], password):
        return User(user)
    return None