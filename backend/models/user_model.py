from flask_bcrypt import generate_password_hash, check_password_hash
from database import users
import datetime

class User:
    @staticmethod
    def create_user(username, email, password, public_key):
        # Hash the password before storing
        hashed_pw = generate_password_hash(password).decode('utf-8')
        
        user_data = {
            "username": username,
            "email": email,
            "password": hashed_pw,
            "public_key": public_key, # Store for E2EE
            "avatar": "default.png",
            "about": "Hey there! I am using BitChat.",
            "contacts": [],
            "created_at": datetime.datetime.utcnow()
        }
        
        if users.find_one({"email": email}):
            return {"error": "Email already exists"}, 400
            
        users.insert_one(user_data)
        return {"success": "User created"}, 201

    @staticmethod
    def authenticate(email, password):
        user = users.find_one({"email": email})
        if user and check_password_hash(user['password'], password):
            return user
        return None