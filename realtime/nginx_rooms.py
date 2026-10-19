#!/usr/bin/env python3
# Adds "location /_rooms" (the relay of the live claim map) to the nginx
# vhost of KLAP, before each "location / {" of a server block that proxies
# to gunicorn. Checks the result with nginx -t and reloads nginx; restores the
# backup when anything fails. Run as root:
#   python3 nginx_rooms.py [vhost] [relay port]
# realtime/install.sh runs it.
import re
import shutil
import subprocess
import sys
import time

vhost = sys.argv[1] if len(sys.argv) > 1 else "/etc/nginx/sites-available/klap"
port = sys.argv[2] if len(sys.argv) > 2 else "8001"

BLOCK = ["location /_rooms {",
         "    proxy_pass http://127.0.0.1:%s;" % port,
         "    proxy_http_version 1.1;",
         "    proxy_set_header Upgrade $http_upgrade;",
         '    proxy_set_header Connection "upgrade";',
         "    proxy_read_timeout 86400s;",
         "}",
         ""]

text = open(vhost, newline="").read()
if "location /_rooms" in text:
    print("%s already has location /_rooms (not changed)" % vhost)
    sys.exit(0)
newline = "\r\n" if "\r\n" in text else "\n"

# "location / {" with any spaces, tabs or line ending around it
LOCATION = re.compile(r"^([ \t]*)location[ \t]+/[ \t]*\{", re.M)
places = [m for m in LOCATION.finditer(text)
          if "proxy_pass" in text[m.end():m.end() + 400]]
if not places:
    print("no 'location / {' with proxy_pass found. The location lines are:")
    for number, line in enumerate(text.splitlines(), 1):
        if "location" in line:
            print("  %d: %r" % (number, line))
    sys.exit(1)

for m in reversed(places):
    indent = m.group(1)
    block = "".join((indent + line if line else "") + newline for line in BLOCK)
    text = text[:m.start()] + block + text[m.start():]

backup = "%s.bak-%s" % (vhost, time.strftime("%Y%m%d%H%M%S"))
shutil.copy2(vhost, backup)
open(vhost, "w", newline="").write(text)
test = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
if test.returncode != 0:
    shutil.copy2(backup, vhost)
    sys.exit("nginx -t failed, %s restored from %s:\n%s" % (vhost, backup, test.stderr))
subprocess.run(["systemctl", "reload", "nginx"], check=True)
print("added location /_rooms (%d place%s) to %s, nginx reloaded (backup: %s)"
      % (len(places), "" if len(places) == 1 else "s", vhost, backup))
