from flask import request, jsonify
from functools import wraps
import jwt
import datetime

# This must match the SECRET_KEY in your auth_routes.py
SECRET_KEY = "your_super_secret_key"

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        
        # Check if the 'Authorization' header is present
        if 'Authorization' in request.headers:
            # Expected format: "Bearer <token>"
            auth_header = request.headers['Authorization']
            try:
                token = auth_header.split(" ")[1]
            except IndexError:
                return jsonify({"error": "Invalid token format"}), 401

        if not token:
            return jsonify({"error": "Token is missing!"}), 401

        try:
            # Decode the token to get the user_id
            data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            current_user_id = data['user_id']
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Token has expired!"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "Invalid token!"}), 401

        # Pass the user_id to the actual route function
        return f(current_user_id, *args, **kwargs)

    return decorated