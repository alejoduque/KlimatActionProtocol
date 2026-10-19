// Room client for the chatb relay (realtime/, from https://r-w-x.org/r/chatb.git).
//
// The relay protocol is chatb's: the server sends {"type":"init"} with our
// id and {"type":"info"} with the room's users; we send {"type":"cmd"} to
// join and set a nick; anything else is relayed to the room, or to one user
// when "to" is set. Payloads travel as JSON strings in "data".
//
// Media is a full mesh of RTCPeerConnections, like chatb, written against the
// current WebRTC API with the "perfect negotiation" pattern so tracks can be
// added, replaced and removed at any time without glare. Each peer also has a
// data channel for ascii frames.

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    function Emitter() {
        this._handlers = {};
    }

    Emitter.prototype = {
        on: function (type, handler) {
            (this._handlers[type] = this._handlers[type] || []).push(handler);
            return this;
        },
        emit: function (type) {
            var args = Array.prototype.slice.call(arguments, 1);
            (this._handlers[type] || []).forEach(function (handler) {
                handler.apply(null, args);
            });
        }
    };

    function Peer(room, id) {
        var _this = this;
        this.room = room;
        this.id = id;
        // the peer with the higher id gives way when both send offers
        this.polite = Number(room.id) > Number(id);
        this.makingOffer = false;
        this.ignoreOffer = false;
        this.senders = {};
        this.stream = new MediaStream();

        var pc = this.pc = new RTCPeerConnection({
            iceServers: room.iceServers
        });

        pc.onnegotiationneeded = async function () {
            try {
                _this.makingOffer = true;
                await pc.setLocalDescription();
                _this.signal({description: pc.localDescription});
            } catch (error) {
                console.warn("negotiation failed: " + error.name + ": " + error.message);
            } finally {
                _this.makingOffer = false;
            }
        };
        pc.onicecandidate = function (event) {
            if (event.candidate) {
                _this.signal({candidate: event.candidate});
            }
        };
        pc.oniceconnectionstatechange = function () {
            if (pc.iceConnectionState === "failed") {
                pc.restartIce();
            }
            room.emit("peerstate", _this.id, pc.iceConnectionState);
        };
        pc.ontrack = function (event) {
            var track = event.track;
            _this.stream.addTrack(track);
            // a replaced or removed sender track shows up here as mute
            track.onmute = track.onunmute = function () {
                room.emit("stream", _this.id, _this.stream);
            };
            track.onended = function () {
                _this.stream.removeTrack(track);
                room.emit("stream", _this.id, _this.stream);
            };
            room.emit("stream", _this.id, _this.stream);
        };

        // Only the impolite side starts. When both sides open their channel
        // and tracks at once, their first offers collide, and ICE candidates
        // sent during the collision can be lost for good. The polite side
        // starts when the first offer has arrived (handleSignal).
        this.started = false;
        if (!this.polite) {
            this.start();
        }

        // a connection that is still not up gets fresh candidates
        this.restarts = 0;
        this.watchdog = setInterval(function () {
            if (pc.connectionState === "connected") {
                _this.restarts = 0;
            } else if (!_this.polite && _this.restarts < 5 &&
                       pc.signalingState === "stable") {
                _this.restarts++;
                pc.restartIce();
            }
        }, 5000);
    }

    Peer.prototype = {
        start: function () {
            var _this = this, room = this.room;
            this.started = true;
            // negotiated: both sides create the same channel, nobody announces it
            this.channel = this.pc.createDataChannel("klap", {negotiated: true, id: 0});
            this.channel.onmessage = function (event) {
                var message;
                try {
                    message = JSON.parse(event.data);
                } catch (e) {
                    return;
                }
                room.emit(message.type, _this.id, message.data);
            };
            this.channel.onopen = function () {
                room.emit("channel", _this.id, true);
            };
            this.channel.onclose = function () {
                room.emit("channel", _this.id, false);
            };
            this.syncTracks();
        },

        signal: function (data) {
            this.room.sendTo(this.id, "rtc", data);
        },

        handleSignal: async function (data) {
            var pc = this.pc;
            try {
                if (data.description) {
                    var description = data.description,
                        collision = description.type === "offer" &&
                            (this.makingOffer || pc.signalingState !== "stable");
                    this.ignoreOffer = !this.polite && collision;
                    if (this.ignoreOffer) {
                        return;
                    }
                    await pc.setRemoteDescription(description);
                    if (!this.started) {
                        this.start();
                    }
                    if (description.type === "offer") {
                        await pc.setLocalDescription();
                        this.signal({description: pc.localDescription});
                    }
                } else if (data.candidate) {
                    try {
                        await pc.addIceCandidate(data.candidate);
                    } catch (error) {
                        if (!this.ignoreOffer) {
                            throw error;
                        }
                    }
                }
            } catch (error) {
                console.warn("signalling failed: " + error.name + ": " + error.message);
            }
        },

        // match what we send to room.tracks; replaceTrack needs no
        // renegotiation, so switching mic or camera on and off is cheap
        syncTracks: function () {
            var _this = this, tracks = this.room.tracks;
            if (!this.started) {
                return;
            }
            ["audio", "video"].forEach(function (kind) {
                var track = tracks[kind], sender = _this.senders[kind];
                if (track && !sender) {
                    _this.senders[kind] = _this.pc.addTrack(
                        track, _this.room.localStream);
                } else if (sender && sender.track !== track) {
                    sender.replaceTrack(track || null);
                }
            });
        },

        send: function (type, data) {
            if (!this.channel || this.channel.readyState !== "open") {
                return false;
            }
            try {
                this.channel.send(JSON.stringify({type: type, data: data}));
            } catch (e) {
                return false;
            }
            return true;
        },

        close: function () {
            clearInterval(this.watchdog);
            this.channel && this.channel.close();
            this.pc.close();
        }
    };

    function Room(options) {
        Emitter.call(this);
        this.name = options.room;
        this.url = Room.resolveUrl(options.wsUrl);
        this.iceServers = options.iceServers || [];
        this.nick = options.nick || "";
        this.id = null;
        this.users = {};
        this.peers = {};
        this.tracks = {audio: null, video: null};
        this.localStream = new MediaStream();
        this.retry = 1000;
    }

    Room.resolveUrl = function (url) {
        var protocol = location.protocol === "https:" ? "wss:" : "ws:";
        if (!url) {
            return protocol + "//" + location.host + "/_rooms";
        }
        if (url.charAt(0) === ":") {
            return protocol + "//" + location.hostname + url;
        }
        return url;
    };

    Room.prototype = Object.create(Emitter.prototype);

    Room.prototype.connect = function () {
        var _this = this, ws;
        try {
            ws = this.ws = new WebSocket(this.url);
        } catch (error) {
            this.emit("status", "offline");
            return;
        }
        this.emit("status", "connecting");

        ws.onopen = function () {
            _this.retry = 1000;
        };
        ws.onmessage = function (event) {
            var message = JSON.parse(event.data), data = message.data;
            if (message.type === "init") {
                _this.id = data;
                _this.command("nick", _this.nick);
                _this.command("join", _this.name);
                _this.emit("status", "live");
                return;
            }
            if (message.type === "info") {
                _this.updateUsers(JSON.parse(data).users || {});
                return;
            }
            try {
                data = data ? JSON.parse(data) : null;
            } catch (e) {
                return;
            }
            if (message.type === "rtc") {
                var peer = _this.peers[message.from];
                peer && peer.handleSignal(data);
                return;
            }
            _this.emit(message.type, message.from, data);
        };
        ws.onclose = function () {
            _this.id = null;
            _this.updateUsers({});
            _this.emit("status", "offline");
            setTimeout(function () {
                _this.connect();
            }, _this.retry);
            _this.retry = Math.min(_this.retry * 2, 30000);
        };
    };

    Room.prototype.updateUsers = function (users) {
        var _this = this, joined = [];
        Object.keys(users).forEach(function (id) {
            if (id !== _this.id && !_this.peers[id]) {
                _this.peers[id] = new Peer(_this, id);
                joined.push(id);
            }
        });
        Object.keys(this.peers).forEach(function (id) {
            if (!users[id]) {
                _this.peers[id].close();
                delete _this.peers[id];
                _this.emit("left", id);
            }
        });
        this.users = users;
        this.emit("users", users, joined);
    };

    Room.prototype.isOpen = function () {
        return this.ws && this.ws.readyState === WebSocket.OPEN && this.id;
    };

    Room.prototype.raw = function (message) {
        if (this.isOpen()) {
            this.ws.send(JSON.stringify(message));
        }
    };

    Room.prototype.command = function (action, data) {
        this.raw({type: "cmd", data: JSON.stringify({action: action, data: data})});
    };

    Room.prototype.setNick = function (nick) {
        this.nick = nick;
        this.command("nick", nick);
    };

    // to everyone else in the room, through the relay
    Room.prototype.broadcast = function (type, data) {
        this.raw({type: type, data: JSON.stringify(data)});
    };

    Room.prototype.sendTo = function (id, type, data) {
        this.raw({type: type, to: id, data: JSON.stringify(data)});
    };

    // to everyone else, peer to peer where a data channel is open and
    // through the relay otherwise; returns nothing, frames are best effort
    Room.prototype.sendFrame = function (type, data, relay) {
        var _this = this;
        Object.keys(this.peers).forEach(function (id) {
            if (!_this.peers[id].send(type, data) && relay) {
                _this.sendTo(id, type, data);
            }
        });
    };

    Room.prototype.setTrack = function (kind, track) {
        var _this = this, old = this.tracks[kind];
        if (old === track) {
            return;
        }
        if (old) {
            this.localStream.removeTrack(old);
        }
        if (track) {
            this.localStream.addTrack(track);
        }
        this.tracks[kind] = track;
        Object.keys(this.peers).forEach(function (id) {
            _this.peers[id].syncTracks();
        });
    };

    assembly.Room = Room;
})(window.arguman = window.arguman || {});
