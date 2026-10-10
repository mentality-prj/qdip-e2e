"""Initialize and assert a real MongoDB single-node replica set on GH runner."""
from __future__ import annotations

import time
from pymongo import MongoClient
from pymongo.errors import PyMongoError

url = "mongodb://127.0.0.1:27019/?directConnection=true"
client = MongoClient(url, serverSelectionTimeoutMS=4000)
try:
    client.admin.command(
        "replSetInitiate",
        {"_id": "rrtest", "members": [{"_id": 0, "host": "127.0.0.1:27019"}]},
    )
except PyMongoError as exc:
    raise RuntimeError("Fresh MongoDB replica-set initialization failed") from exc

for _ in range(45):
    try:
        hello = client.admin.command("hello")
        if hello.get("setName") == "rrtest" and hello.get("isWritablePrimary"):
            print("RR_NATIVE_REAL_MONGODB_REPLICA=PASS")
            break
    except PyMongoError:
        pass
    time.sleep(1)
else:
    raise RuntimeError("No elected native mongod primary; fail closed")
client.close()
