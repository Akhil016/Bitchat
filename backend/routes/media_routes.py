from flask import Blueprint, request, jsonify
import os
from werkzeug.utils import secure_filename

media_bp = Blueprint('media', __name__)
UPLOAD_FOLDER = 'uploads/'

@media_bp.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    
    file = request.files['file']
    filename = secure_filename(file.filename)
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    file.save(filepath)
    
    # Return the URL so the socket can broadcast it to the contact
    return jsonify({"url": f"http://localhost:5000/uploads/{filename}"}), 200