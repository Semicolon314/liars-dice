from functools import wraps
import uuid
import json

from flask import Flask, session, render_template, request, g
from flask.ext.redis import FlaskRedis
from redis import StrictRedis

app = Flask(__name__)
app.secret_key = "n0tv3rys3cr3t"
r = FlaskRedis.from_custom_provider(StrictRedis, app)

# -------- HACKY CONFIG -------- #

EXPIRE_SECONDS = 10
MIN_PLAYERS = 2
MAX_PLAYERS = 5


# -------- REDIS METHODS -------- #

def token_key(token): # actually username
    return "token:{0}".format(token)

def updates_key(token):
    return "updates:{0}".format(token)

def update_id_key(token):
    return "update_key:{0}".format(token)

def status_key(token):
    return "status:{0}".format(token)

def create_new_token(username):
    token = str(uuid.uuid4())
    pipe = r.pipeline()
    rkey = token_key(token)
    pipe.set(rkey, username)
    pipe.expire(rkey, EXPIRE_SECONDS)
    pipe.sadd("active_users", token)
    pipe.execute()
    return token

def ping_token(token):
    rkey = token_key(token)
    username = r.get(rkey)
    if username:
        r.expire(rkey, EXPIRE_SECONDS)
    return username

def user_active(token):
    username = r.get(token_key(token))
    return username.decode("utf-8") if username else None

def delete_user(token):
    r.srem("active_users", token)
    status = r.get(status_key(token))
    r.delete(status_key(token))

    # do stuff based on the status
    if status and status.decode("utf-8")[:5] == "queue":
        r.srem(status, token)

# Update is a dictionary
def push_update(token, update):
    if not user_active(token):
        return False
    rkey = updates_key(token)
    idkey = update_id_key(token)
    ident = r.incr(idkey)
    update["id"] = ident
    r.rpush(rkey, json.dumps(update))
    return True

# Gets updates since the given update id
def get_updates(token, update_id=0):
    rkey = updates_key(token)
    idkey = update_id_key(token)

    pipe = r.pipeline()
    pipe.llen(rkey)
    pipe.get(idkey)
    results = pipe.execute()

    size = results[0]
    if size == 0: return []
    last_id = int(results[1])
    first_id = last_id - size + 1
    first_unseen_index = max(0, update_id - first_id + 1)

    pipe = r.pipeline()
    pipe.ltrim(rkey, first_unseen_index, -1)
    pipe.lrange(rkey, 0, -1)
    results = pipe.execute()

    return list(map(json.loads, (v.decode("utf-8") for v in results[1])))

def get_active_users():
    actives = r.smembers("active_users")
    rval = []
    for token in actives:
        token = token.decode("utf-8")
        if user_active(token):
            rval.append(token)
        else:
            delete_user(token)
    return rval

def get_status(token):
    if user_active(token):
        status = r.get(status_key(token))
        return status.decode("utf-8") if status else "lobby"
    return None

def get_queue(queuetype):
    qkey = "queue:{0}".format(queuetype)
    queue = {"users": [], "size": queuetype}
    member_tokens = [v.decode("utf-8") for v in r.smembers(qkey)]
    for member in member_tokens:
        username = user_active(member)
        if username:
            queue["users"].append({
                "id": short_id(member),
                "name": username
            })
        else:
            delete_user(member)
    return queue

def join_queue(token, queuetype):
    if queuetype < MIN_PLAYERS or queuetype > MAX_PLAYERS:
        return False

    # TODO: this method has some theoretical breaking points
    # also redundant calls to redis because hack

    status = get_status(token)
    # Ensure that they are just in the lobby
    if status != "lobby":
        return False

    # go through the queue first and remove any inactive users
    qkey = "queue:{0}".format(queuetype)
    members = r.smembers(qkey)
    for member in members:
        member = member.decode("utf-8")
        if not user_active(member):
            r.srem(qkey, member)

    # add them to the queue and change their status and get the new size of the queue
    pipe = r.pipeline()
    pipe.set(status_key(token), qkey)
    pipe.sadd(qkey, token)
    pipe.scard(qkey)
    results = pipe.execute()

    # if the queue isn't full, send all queue users updates about the queue
    qsize = int(results[2]) if results[2] else 0
    if qsize < queuetype:
        update = get_queue(queuetype)
        update["type"] = "queue"
        update["status"] = qkey

        member_tokens = [v.decode("utf-8") for v in r.smembers(qkey)]
        for member in member_tokens:
            push_update(member, update)
    else:
        # start the game!
        pass

    return True

def leave_queue(token):
    # ensure they're in a queue
    status = get_status(token)
    if status[:5] != "queue":
        return False

    queuetype = int(status.split(":")[1])
    qkey = status
    pipe = r.pipeline()
    pipe.srem(qkey, token)
    pipe.set(status_key(token), "lobby")
    pipe.scard(qkey)
    results = pipe.execute()

    qsize = int(results[2]) if results[2] else 0
    if qsize > 0:
        update = get_queue(queuetype)
        update["type"] = "queue"
        update["status"] = qkey

        member_tokens = [v.decode("utf-8") for v in r.smembers(qkey)]
        for member in member_tokens:
            push_update(member, update)

    return True


# -------- HELPER METHODS -------- #

def short_id(token):
    return token.split("-")[0]


# -------- DECORATORS -------- #

def check_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        username = ping_token(session["token"])
        if username:
            g.token = session["token"] # easier access
            g.username = username.decode("utf-8")
            return f(*args, **kwargs)
        else:
            return json.dumps({"error": "bad auth"})
    return decorated_function


# -------- ROUTES -------- #

@app.route("/")
def route_main():
    return render_template("index.html", token=session["token"] if "token" in session and ping_token(session["token"]) else "")

@app.route("/token")
def route_token():
    username = request.args.get("username", None)
    if username:
        # Create a token for the user
        token = create_new_token(username)
        session["token"] = token
        return json.dumps({"token": token, "username": username})
    else:
        return json.dumps({"error": "specify username"})

@app.route("/updates")
@check_auth
def route_updates():
    update_id = int(request.args.get("id", 0))
    return json.dumps({"updates": get_updates(g.token, update_id)})

@app.route("/chat", methods=["POST"])
@check_auth
def route_chat():
    if not request.json["message"]:
        return json.dumps({"error": "no message"})

    update = {
        "type": "chat",
        "user": {
            "id": short_id(g.token),
            "name": g.username
        },
        "message": request.json["message"]
    }

    users = get_active_users()
    for user in users:
        push_update(user, update)

    return json.dumps({"success": 1})

@app.route("/getqueues")
@check_auth
def route_getqueues():
    queues = []
    for i in range(MIN_PLAYERS, MAX_PLAYERS + 1):
        queues.append(get_queue(i))
    return json.dumps(queues)

@app.route("/joinqueue", methods=["POST"])
@check_auth
def route_joinqueue():
    queuetype = request.json["queuetype"]
    if not queuetype:
        return json.dumps({"error": "specify queuetype"})
    success = join_queue(g.token, queuetype)
    if success:
        return json.dumps({"success": 1})
    else:
        return json.dumps({"error": "there was a problem joining the queue"})

@app.route("/leavequeue", methods=["POST"])
@check_auth
def route_leavequeue():
    success = leave_queue(g.token)
    if success:
        push_update(g.token, {"type": "status", "status": "lobby"})
        return json.dumps({"success": 1})
    else:
        return json.dumps({"error": "there was a problem leaving the queue"})

@app.route("/status")
@check_auth
def route_status():
    status = get_status(g.token)
    obj = {"status": status, "username": g.username}
    if status[:5] == "queue":
        queue = get_queue(int(status.split(":")[1]))
        obj["users"] = queue["users"]
        obj["size"] = queue["size"]
    return json.dumps(obj)


# -------- START APP -------- #

if __name__ == "__main__":
    app.run()