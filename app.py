"""
IP Plan Manager - Flask Application
Quản lý IP theo VLAN, lưu trữ dạng JSON file
Có đăng nhập Admin + đổi password
"""

import os
import json
import uuid
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, jsonify, send_file, session, redirect, url_for
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "ipplan-secret-key-change-me")
CORS(app)

DATA_DIR = os.environ.get("DATA_DIR", "./data")
DATA_FILE = os.path.join(DATA_DIR, "ipplan.json")
AUTH_FILE = os.path.join(DATA_DIR, "auth.json")

DEFAULT_USERNAME = "Admin"
DEFAULT_PASSWORD = "Admin@123"


# ---- Auth helpers ----

def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def load_auth():
    ensure_data_dir()
    if os.path.exists(AUTH_FILE):
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    # Create default credentials
    auth = {
        "username": DEFAULT_USERNAME,
        "password_hash": generate_password_hash(DEFAULT_PASSWORD),
    }
    save_auth(auth)
    return auth


def save_auth(auth):
    ensure_data_dir()
    with open(AUTH_FILE, "w", encoding="utf-8") as f:
        json.dump(auth, f, ensure_ascii=False, indent=2)


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated


# ---- Data helpers ----

def load_data():
    ensure_data_dir()
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"vlans": []}


def save_data(data):
    ensure_data_dir()
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def generate_ips(subnet, prefix):
    """Generate IP list from subnet and prefix length."""
    parts = subnet.strip().split(".")
    if len(parts) != 4:
        return []
    base = [int(p) for p in parts]
    if prefix == 32:
        return [subnet]
    count = 2 ** (32 - int(prefix))
    ips = []
    base_int = (base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]
    mask = (0xFFFFFFFF << (32 - int(prefix))) & 0xFFFFFFFF
    base_int = base_int & mask
    for i in range(count):
        ip_int = base_int + i
        ip = f"{(ip_int >> 24) & 0xFF}.{(ip_int >> 16) & 0xFF}.{(ip_int >> 8) & 0xFF}.{ip_int & 0xFF}"
        ips.append(ip)
    return ips


# ---- Auth Routes ----

@app.route("/login")
def login_page():
    if session.get("logged_in"):
        return redirect(url_for("index"))
    return render_template("login.html")


@app.route("/api/login", methods=["POST"])
def api_login():
    body = request.json
    username = body.get("username", "")
    password = body.get("password", "")
    auth = load_auth()
    if username == auth["username"] and check_password_hash(auth["password_hash"], password):
        session["logged_in"] = True
        session["username"] = username
        return jsonify({"ok": True})
    return jsonify({"error": "Sai tên đăng nhập hoặc mật khẩu"}), 401


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/change-password", methods=["POST"])
@login_required
def api_change_password():
    body = request.json
    current = body.get("current_password", "")
    new_pass = body.get("new_password", "")
    if not new_pass or len(new_pass) < 6:
        return jsonify({"error": "Mật khẩu mới phải có ít nhất 6 ký tự"}), 400
    auth = load_auth()
    if not check_password_hash(auth["password_hash"], current):
        return jsonify({"error": "Mật khẩu hiện tại không đúng"}), 400
    auth["password_hash"] = generate_password_hash(new_pass)
    save_auth(auth)
    return jsonify({"ok": True})


# ---- Page Routes ----

@app.route("/")
@login_required
def index():
    return render_template("index.html")


# ---- API Routes ----

@app.route("/api/vlans", methods=["GET"])
@login_required
def get_vlans():
    data = load_data()
    result = []
    for v in data["vlans"]:
        total = len(v.get("ips", []))
        used = sum(1 for ip in v.get("ips", []) if ip.get("used"))
        result.append({
            "id": v["id"],
            "name": v["name"],
            "vlan_id": v["vlan_id"],
            "subnet": v["subnet"],
            "prefix": v["prefix"],
            "description": v.get("description", ""),
            "total_ips": total,
            "used_ips": used,
            "free_ips": total - used,
        })
    return jsonify(result)


@app.route("/api/vlans", methods=["POST"])
@login_required
def create_vlan():
    body = request.json
    name = body.get("name", "").strip()
    vlan_id = body.get("vlan_id")
    subnet = body.get("subnet", "").strip()
    prefix = int(body.get("prefix", 24))
    description = body.get("description", "")
    if not name or not subnet:
        return jsonify({"error": "Tên và Subnet là bắt buộc"}), 400
    ips = generate_ips(subnet, prefix)
    if not ips:
        return jsonify({"error": "Subnet không hợp lệ"}), 400
    ip_entries = []
    for ip in ips:
        ip_entries.append({
            "address": ip,
            "used": False,
            "hostname": "",
            "system": "",
            "owner": "",
            "description": "",
            "updated_at": "",
        })
    vlan = {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "vlan_id": vlan_id,
        "subnet": subnet,
        "prefix": prefix,
        "description": description,
        "ips": ip_entries,
        "created_at": datetime.now().isoformat(),
    }
    data = load_data()
    data["vlans"].append(vlan)
    save_data(data)
    return jsonify({"id": vlan["id"], "total_ips": len(ip_entries)}), 201


@app.route("/api/vlans/<vlan_id>", methods=["DELETE"])
@login_required
def delete_vlan(vlan_id):
    data = load_data()
    data["vlans"] = [v for v in data["vlans"] if v["id"] != vlan_id]
    save_data(data)
    return jsonify({"ok": True})


@app.route("/api/vlans/<vlan_id>/ips", methods=["GET"])
@login_required
def get_ips(vlan_id):
    data = load_data()
    for v in data["vlans"]:
        if v["id"] == vlan_id:
            return jsonify(v["ips"])
    return jsonify({"error": "VLAN not found"}), 404


@app.route("/api/vlans/<vlan_id>/ips/<ip_address>", methods=["PUT"])
@login_required
def update_ip(vlan_id, ip_address):
    body = request.json
    data = load_data()
    for v in data["vlans"]:
        if v["id"] == vlan_id:
            for ip in v["ips"]:
                if ip["address"] == ip_address:
                    ip["used"] = body.get("used", ip["used"])
                    ip["hostname"] = body.get("hostname", ip["hostname"])
                    ip["system"] = body.get("system", ip["system"])
                    ip["owner"] = body.get("owner", ip["owner"])
                    ip["description"] = body.get("description", ip["description"])
                    ip["updated_at"] = datetime.now().isoformat()
                    save_data(data)
                    return jsonify(ip)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/vlans/<vlan_id>/ips/<ip_address>", methods=["DELETE"])
@login_required
def clear_ip(vlan_id, ip_address):
    data = load_data()
    for v in data["vlans"]:
        if v["id"] == vlan_id:
            for ip in v["ips"]:
                if ip["address"] == ip_address:
                    ip["used"] = False
                    ip["hostname"] = ""
                    ip["system"] = ""
                    ip["owner"] = ""
                    ip["description"] = ""
                    ip["updated_at"] = datetime.now().isoformat()
                    save_data(data)
                    return jsonify(ip)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/export", methods=["GET"])
@login_required
def export_data():
    if not os.path.exists(DATA_FILE):
        save_data({"vlans": []})
    return send_file(DATA_FILE, as_attachment=True, download_name="ipplan.json")


@app.route("/api/import", methods=["POST"])
@login_required
def import_data():
    if "file" in request.files:
        f = request.files["file"]
        content = json.load(f)
    else:
        content = request.json
    if "vlans" not in content:
        return jsonify({"error": "Invalid format"}), 400
    save_data(content)
    return jsonify({"ok": True, "vlans": len(content["vlans"])})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("DEBUG", "false").lower() == "true")
