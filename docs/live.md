# The live claim map

Each claim page is shared live by all the people who have it open. There is
no separate room: open a claim, and send its address to the people who take
part.

## What happens on the map

- **Type to start.** With a mouse, a blinking caret follows the pointer over
  the map. On the claim or on a reason it becomes a prompt: "> type to
  answer". On a word it becomes "> what do we mean by “word”?". Typing a
  letter then starts a reason in that place. Without a pointer on a node,
  the letter answers the reason selected with the arrow keys, or else the
  claim.
- **The reason types float.** With a mouse, the reason types ("but …",
  "because …", …) come with the prompt. While the pointer moves they trail
  it, faint, and the pointer goes through them. When it rests, they settle
  under it and wait: select one to answer the reason (or the claim) that the
  prompt was on. That reason gets a grey field while the pointer is on the
  types. They go when nothing moves. On a touch screen they stay under the
  claim.
- **Threads, not frames.** Reasons are open text. A thread joins each reason
  to the claim or to its parent, in the line of its type (table below). A
  question about a word hangs from that word. The thread of a reason being
  typed is grey and moves. With a mouse, the author, the fallacy reports,
  the supporters and "add reason", "support" show when you point at a
  reason.
- **Explanations come and go.** The short explanations (over the claim,
  under the reason types, and in the box: the meaning of the type above the
  text, the keys under it) show while the pointer moves and while you type,
  then fade. The buttons always stay. On a touch screen the explanations
  always show and there is no caret.
- **Reasons are typed in the map.** Under the claim, select a reason type.
  Or select "add reason" on a reason. A box opens as a new node of the map,
  at the place where the reason will go. Enter adds the reason. Escape
  closes the box. "+ sources" and "+ related claim" give the same fields as
  the old form.
- **All people see the typing.** Each edit goes to the others with its
  timing (Time Based Text, after [TBT](https://github.com/dyne/TBT)). So
  they see the reason typed at the pace it was typed, with the pauses and the
  corrections. It shows in a grey node with a black bar, at the place where
  the reason will go: "> ana writes :: but".
- **Reason types:**

  | reason type        | use                                              | score     | thread        |
  |--------------------|--------------------------------------------------|-----------|---------------|
  | because            | a reason that supports the claim                 | supports  | solid         |
  | but                | a reason against the claim                       | objects   | double        |
  | however            | more information or a condition                  | —         | dashed        |
  | and so             | a result of the claim; it takes the claim further| supports  | heavy solid   |
  | on the contrary    | the opposite claim                               | objects   | double        |
  | in other words     | the claim in different words, to check that you understand it | — | dotted |
  | what do we mean by | a question about the meaning of one word         | —         | dotted, grey  |
  | what if            | a different possibility                          | —         | dashed, grey  |

- **Each word can be questioned.** Click a word of the claim or of a reason
  to ask "what do we mean by" about it. Shift-click adds more words. While
  someone types a question, the word has a grey field for all. When the
  question is added, the word gets a dotted line and a number.
- **Support and fallacies in place.** "support" and "report fallacy" work in
  the node. The map changes for all people when someone adds a reason,
  supports one or reports a fallacy.
- **Replay session.** "▶ replay session" types the whole discussion again,
  reason by reason, in the order and at the pace it happened (1×, 4× or 16×).
  Each reason also has its recording as a `.tbt` file for dyne's player
  (`/<claim>/premises/<id>/tbt.json` gives the recording).
- **People, voice, video, ascii video.** The strip at the right side (at the
  bottom on a phone) shows the people on the page. Under "settings": your
  name, the microphone, and the camera: no camera, **ascii** or video. In
  ascii mode the browser changes the picture into text and sends only the
  text: the camera image stays on the computer. "show all video as ascii"
  changes all incoming video to ascii. Video shows in greys only. Each tile
  shows when the person types; click it to go to their node.

Without JavaScript the claim page is the normal tree, and
`/<claim>/premises/new?form=1` is the old form.

## How it is built

```
browser ── HTTPS ──────────► Django (gunicorn)   claim, map, reasons, .tbt
   │
   ├─── WebSocket /_rooms ─► klap-realtime        chatb room relay (realtime/)
   │                          typing stream, presence, map changes,
   │                          WebRTC signalling
   └─── WebRTC (mesh) ──────► other browsers      voice, video, ascii frames
```

- `realtime/` is the room relay of [chatb](https://r-w-x.org/r/chatb.git), in
  Go, with chatb's protocol. It sends messages between the people on a claim
  page and keeps nothing.
- `web/static/js/assembly/room.js` uses chatb's protocol and makes the
  WebRTC mesh, like chatb. Only one side of each pair starts the connection,
  and a connection that does not come up gets new ICE candidates.
- `web/static/js/assembly/live.js` makes the map live. The layout is
  KLAP's own tree (`arguman.Tree` in `main.js`). Typing boxes and drafts
  are nodes of the tree, and the map is refreshed in place from
  `/<claim>?partial=tree`.
- `web/static/js/assembly/tbt.js` records, streams and plays Time Based Text,
  and converts to TBT's key format.
- `web/static/js/assembly/presence.js` is the strip of people; `ascii.js`
  uses the steps of [hasciicam](https://github.com/dyne/hasciicam): BT.601
  luma, the AA-lib table for brightness, contrast, gamma and inversion,
  Floyd–Steinberg dithering, and a character ramp.
- `css/live.css` follows the rules of `css/permasoftware.css`.

chatb, hasciicam and TBT are GPLv3, like KLAP.

## Install on the server

On a server that `deploy-wizard.sh` installed, run once from the KLAP
checkout, after `git pull`, `migrate` and `collectstatic`:

```sh
sudo bash realtime/install.sh          # port 8001; give another port if it is used
```

The script gets Go into `/opt/klap-go` (only to build), builds
`/usr/local/bin/klap-realtime`, starts `klap-realtime.service` on
127.0.0.1, and adds this to the nginx vhost (it keeps a backup and restores
it if `nginx -t` fails):

```nginx
location /_rooms {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
}
```

Django needs no new setting: the browser finds the relay at `/_rooms` on the
same host. A new install with `deploy-wizard.sh` does this as its last step.

## Run it on your computer

`docker compose up` starts the relay next to the app (port 8001).
`settings_local.py` tells the browser where it is:

```python
REALTIME_WS_URL = ':8001/_rooms'  # same hostname as the page, port 8001
```

## Before a workshop

- **HTTPS.** Browsers give the camera and the microphone only to `https://`
  pages or `localhost`. On plain `http://`, people can type and add reasons,
  but cannot send sound or pictures.
- **Networks.** `ICE_SERVERS` is empty, so voice and video connect people on
  the same network (a room, the wifi of a bookshop) with no third party. To
  connect people on different networks, run a STUN/TURN server (for example
  coturn) and add it to `ICE_SERVERS`. Typing and reasons go through the
  relay and work on all networks.
- **Size.** The mesh is good for approximately 6–8 people with video. Ascii
  and sound only can be more. Typing has no practical limit.
- **Names.** Each person writes a name in the room. KLAP keeps the name on
  the guest profile when the person adds a reason.
