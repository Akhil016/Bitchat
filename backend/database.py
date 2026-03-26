from pymongo import MongoClient
import os

# Assuming a local MongoDB setup; swap with Atlas URI if needed
MONGO_URI = "mongodb://localhost:27017/"
client = MongoClient(MONGO_URI)

# Database Name
db = client['BitChatdb']

# Collections
users = db['users']
messages = db['messages']
chats = db['chats']

print("Connected to MongoDB successfully.")