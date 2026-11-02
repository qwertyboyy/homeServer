#!/usr/bin/python3
"""Apache RewriteMap prg protocol: one session token in, OK/DENY out.
No caching: dashboard logout/expiry must take effect on the next request.
"""
import http.client
import re
import sys


def check_session(token, host="127.0.0.1", port=3001):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        return "DENY"
    connection = http.client.HTTPConnection(host, port, timeout=2)
    try:
        connection.request("GET", "/api/v1/auth/me", headers={"Cookie": "nif_session=" + token})
        response = connection.getresponse()
        # Never follow redirects or accept a backend error as authentication.
        return "OK" if response.status == 200 else "DENY"
    except (OSError, http.client.HTTPException):
        return "DENY"
    finally:
        connection.close()


def main():
    for line in sys.stdin:
        # No output besides protocol results, especially no tokens or tracebacks.
        try:
            result = check_session(line.rstrip("\r\n"))
        except Exception:
            result = "DENY"
        print(result, flush=True)


if __name__ == "__main__":
    main()
