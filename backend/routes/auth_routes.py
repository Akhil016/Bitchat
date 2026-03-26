from flask import Blueprint, request, jsonify
from models.user_model import User
import jwt
import datetime
from middleware import token_required
from database import users


auth_bp = Blueprint('auth', __name__)
SECRET_KEY = "your_super_secret_key"



@auth_bp.route('/profile', methods=['GET'])
@token_required
def get_my_profile(current_user_id):
    # This route only runs if the token is valid
    # 'current_user_id' is automatically passed from the middleware
    user = users.find_one({"_id": ObjectId(current_user_id)}, {"password": 0})
    return jsonify(user), 200
@auth_bp.route('/signup', methods=['POST'])
def signup():
    data = request.json
    # public_key is sent from frontend for E2EE
    result, status = User.create_user(data['username'], data['email'], data['password'], data['public_key'])
    return jsonify(result), status

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.json
    user = User.authenticate(data['email'], data['password'])
    if user:
        token = jwt.encode({
            'user_id': str(user['_id']),
            'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=24)
        }, SECRET_KEY)
        return jsonify({"token": token, "username": user['username'], "public_key": user['public_key']}), 200
    return jsonify({"error": "Invalid credentials"}), 401