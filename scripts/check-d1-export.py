"""Restore a D1 SQL export in memory and fingerprint each shop's orders and stock."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def fingerprint(records):
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def summary(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"organizations", "members", "sessions", "invites"} <= tables:
        raise ValueError("Required RetailPilot tables are missing")
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("SQLite integrity check failed")
    if db.execute("PRAGMA foreign_key_check").fetchone():
        raise ValueError("Foreign-key check failed")
    shops = []
    for org, revision, raw in db.execute("SELECT id, revision, document FROM organizations ORDER BY id"):
        shop = json.loads(raw)
        orders = sorted(shop["orders"], key=lambda order: order["id"])
        stock = sorted((product["id"], product["stock"]) for product in shop["products"])
        shops.append(dict(org=org, revision=revision, orders=len(orders), variants=len(stock),
                          order_digest=fingerprint(orders), stock_digest=fingerprint(stock)))
    return shops


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--baseline", type=Path, help="Compare with a JSON summary from the same source revision")
    args = parser.parse_args()
    db = sqlite3.connect(":memory:")
    try:
        db.set_authorizer(lambda op, *_: sqlite3.SQLITE_DENY if op in
                          (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) else sqlite3.SQLITE_OK)
        db.executescript(args.export.read_text(encoding="utf-8-sig"))
        shops = summary(db)
        if args.baseline and shops != json.loads(args.baseline.read_text(encoding="utf-8-sig")):
            raise ValueError("Workspace revisions, orders or inventory differ from the supplied baseline")
        print(json.dumps(shops, indent=2))
    finally:
        db.close()


if __name__ == "__main__":
    main()
