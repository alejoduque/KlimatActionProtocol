// People on the claim page: a strip of tiles with voice, video and ascii
// video, over chatb's room relay and WebRTC mesh (room.js).
//
// The microphone and the camera stay off until a person starts them. Their
// buttons are always on the page. When a device does not start, the strip
// says why (no permission, no device, another application uses it, no
// https) and what to do, next to the button. In
// ascii mode the camera image is turned into text here (ascii.js, after
// hasciicam) and only the text frames are sent: the image never leaves the
// computer. Permasoftware style: no colour; video is shown in greys.

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    var ASCII_FPS = 8,
        RELAY_EVERY = 4,  // frames through the relay at ASCII_FPS / RELAY_EVERY
        NOTE = gettext("Ascii sends only text. Your camera image stays on your computer.");

    // why a device did not start, and what the person can do
    var PROBLEMS = {
        audio: {
            insecure: gettext("The microphone needs https. This page is not secure, so the browser does not allow it."),
            asking: gettext("The browser asks if this page can use the microphone. Choose Allow."),
            dismissed: gettext("You closed the question of the browser. Press the button again, and choose Allow."),
            blocked: gettext("The browser blocks the microphone for this site. Click the icon at the left of the address, allow the microphone, and try again."),
            system: gettext("The system does not let this browser use the microphone. Open the privacy settings of your computer or phone, allow the microphone for this browser, and try again."),
            refused: gettext("The microphone was not allowed. Press the button again, and choose Allow. If the browser does not ask, allow the microphone in the settings of the browser and of the system."),
            missing: gettext("No microphone found. Connect one, and try again."),
            busy: gettext("The microphone does not answer. Perhaps another application uses it, for example a video call. Close that application, and try again."),
            lost: gettext("The microphone stopped. Perhaps it was unplugged, or another application took it."),
            silent: gettext("The microphone gives no sound. Perhaps it is muted in the system or on the headset."),
            other: gettext("The microphone did not start (%(error)s).")
        },
        video: {
            insecure: gettext("The camera needs https. This page is not secure, so the browser does not allow it."),
            asking: gettext("The browser asks if this page can use the camera. Choose Allow."),
            dismissed: gettext("You closed the question of the browser. Press the button again, and choose Allow."),
            blocked: gettext("The browser blocks the camera for this site. Click the icon at the left of the address, allow the camera, and try again."),
            system: gettext("The system does not let this browser use the camera. Open the privacy settings of your computer or phone, allow the camera for this browser, and try again."),
            refused: gettext("The camera was not allowed. Press the button again, and choose Allow. If the browser does not ask, allow the camera in the settings of the browser and of the system."),
            missing: gettext("No camera found. Connect one, and try again."),
            busy: gettext("The camera does not answer. Perhaps another application uses it, for example a video call. Close that application, and try again."),
            lost: gettext("The camera stopped. Perhaps it was unplugged, or another application took it."),
            other: gettext("The camera did not start (%(error)s).")
        }
    };

    var CONSTRAINTS = {
        audio: {audio: {echoCancellation: true, noiseSuppression: true}},
        video: {video: {width: {ideal: 640}, height: {ideal: 480}}}
    };

    function el(tag, className, text) {
        var element = document.createElement(tag);
        if (className) {
            element.className = className;
        }
        if (text !== undefined && text !== null) {
            element.textContent = text;
        }
        return element;
    }

    function button(className, text, action) {
        var element = el("button", className, text);
        element.type = "button";
        if (action) {
            element.setAttribute("data-action", action);
        }
        return element;
    }

    function storage(key, value) {
        try {
            if (value === undefined) {
                return localStorage.getItem(key);
            }
            localStorage.setItem(key, value);
        } catch (e) {
            return null;
        }
    }

    function problem(code) {
        var error = new Error(code);
        error.code = code;
        return error;
    }

    // the PermissionStatus of the browser for a device, or null when the
    // browser does not tell
    function permissionStatus(kind) {
        try {
            return navigator.permissions.query({
                name: kind === "audio" ? "microphone" : "camera"
            }).catch(function () {
                return null;
            });
        } catch (e) {
            return Promise.resolve(null);
        }
    }

    // why getUserMedia failed: a key of PROBLEMS
    function diagnose(kind, error) {
        var name = error && error.name || "", message = error && error.message || "";
        return permissionStatus(kind).then(function (status) {
            var state = status && status.state;
            if (state === "denied") {
                return "blocked";  // whatever the error says
            }
            if (name === "NotFoundError" || name === "DevicesNotFoundError" ||
                    name === "OverconstrainedError") {
                return "missing";
            }
            if (name === "NotReadableError" || name === "TrackStartError" ||
                    name === "AbortError") {
                return "busy";
            }
            if (name === "NotAllowedError" || name === "PermissionDeniedError" ||
                    name === "SecurityError") {
                if (/dismiss/i.test(message)) {
                    return "dismissed";
                }
                // when the site is allowed, the refusal comes from the system
                return /system/i.test(message) || state === "granted" ? "system" : "refused";
            }
            return "other";
        });
    }

    // one live track of the kind, or an error with a code of PROBLEMS
    function acquire(kind) {
        var devices = navigator.mediaDevices, plain = {};
        if (window.isSecureContext === false || !devices || !devices.getUserMedia) {
            return Promise.reject(problem("insecure"));
        }
        plain[kind] = true;
        return devices.getUserMedia(CONSTRAINTS[kind]).catch(function (error) {
            // a device that cannot do what we prefer is still a device
            if (error && (error.name === "OverconstrainedError" ||
                          error.name === "ConstraintNotSatisfiedError")) {
                return devices.getUserMedia(plain);
            }
            throw error;
        }).then(function (stream) {
            return kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
        }, function (error) {
            return diagnose(kind, error).then(function (code) {
                var failure = problem(code);
                failure.detail = error && (error.name || String(error));
                throw failure;
            });
        });
    }

    // options: room, name, onName(name), writingLabel(id) -> text or null,
    // onGoto(id), named (false: the person has not given a name yet),
    // compact (true: on a narrow screen the tiles start folded)
    function Presence(container, options) {
        this.container = container;
        this.room = options.room;
        this.options = options;
        this.people = {};
        this.tiles = {};
        this.asciiView = storage("klap.live.asciiView") === "1";
        this.me = {name: options.name, mic: false, cam: "off"};
        this.named = options.named !== false;
        this.open = !options.compact;
        this.camTrack = null;
        // what the person asked for last; the answer of a device can come late
        this.wanted = {audio: false, video: "off"};
        this.asking = {audio: false, video: false};
        this.problems = {audio: null, video: null};
        // inverted (AA-lib's inversion): dark text on paper, like the rest of KLAP
        this.renderer = new assembly.ascii.Renderer({cols: 72, inversion: true});
        this.frameCount = 0;
        this.build();
        this.bind();
        this.watch();
    }

    Presence.prototype = {
        build: function () {
            var root = this.container;
            root.textContent = "";

            var head = el("div", "strip-head");
            head.appendChild(el("strong", null, gettext("present")));
            this.status = el("span", "strip-status", gettext("connecting…"));
            head.appendChild(this.status);
            root.appendChild(head);

            // the microphone and the camera: always on the page
            var media = el("div", "strip-media");
            this.micButton = button("media-toggle", "", "mic");
            this.micButton.title = gettext("Turn your microphone on or off. The browser asks for permission the first time.");
            media.appendChild(this.micButton);
            this.statusEls = {audio: el("p", "media-status"), video: el("p", "media-status")};
            this.statusEls.audio.setAttribute("role", "status");
            this.statusEls.video.setAttribute("role", "status");
            media.appendChild(this.statusEls.audio);

            var cams = el("div", "cam-modes");
            cams.setAttribute("role", "group");
            cams.setAttribute("aria-label", gettext("camera"));
            this.camLabel = el("span", "cam-label");
            cams.appendChild(this.camLabel);
            this.camButtons = {};
            [["off", gettext("off"), gettext("Turn your camera off.")],
             ["ascii", "ascii", gettext("Camera as text. Only text is sent: your image stays on your computer.")],
             ["video", gettext("video"), gettext("Camera as video. Other people here see your image.")]]
                .forEach(function (mode) {
                    var b = button("cam-mode", mode[1], "cam");
                    b.setAttribute("data-mode", mode[0]);
                    b.title = mode[2];
                    this.camButtons[mode[0]] = b;
                    cams.appendChild(b);
                }, this);
            media.appendChild(cams);
            media.appendChild(this.statusEls.video);

            this.fold = button("strip-fold link", "", "fold");
            this.fold.title = gettext("Show or hide the people here, your name and the settings.");
            media.appendChild(this.fold);
            root.appendChild(media);

            // the rest folds away on a narrow screen
            var more = el("div", "strip-more");
            var nameLabel = this.nameLabel = el("label", "strip-name");
            nameLabel.appendChild(el("span", null, gettext("your name")));
            this.nameInput = el("input");
            this.nameInput.type = "text";
            this.nameInput.maxLength = 30;
            this.nameInput.value = this.named ? this.me.name : "";
            this.nameInput.placeholder = gettext("write your name");
            this.nameInput.title = gettext("Other people here see this name.");
            nameLabel.appendChild(this.nameInput);
            more.appendChild(nameLabel);

            this.toggle = button("strip-toggle link", gettext("settings"), "toggle");
            this.toggle.setAttribute("aria-expanded", "false");
            more.appendChild(this.toggle);

            var controls = this.controls = el("div", "strip-controls");
            controls.hidden = true;
            var asciiLabel = el("label", "ascii-view");
            this.asciiViewInput = el("input");
            this.asciiViewInput.type = "checkbox";
            this.asciiViewInput.checked = this.asciiView;
            asciiLabel.appendChild(this.asciiViewInput);
            asciiLabel.appendChild(document.createTextNode(" " + gettext("show all video as ascii")));
            controls.appendChild(asciiLabel);
            controls.appendChild(el("p", "strip-note", NOTE));
            more.appendChild(controls);

            this.tilesEl = el("div", "strip-tiles");
            more.appendChild(this.tilesEl);
            root.appendChild(more);

            this.localVideo = el("video");
            this.localVideo.muted = true;
            this.localVideo.playsInline = true;
            this.localVideo.autoplay = true;

            this.updateFold();
            this.updateControls();
            this.updateTile("me");
        },

        bind: function () {
            var _this = this, room = this.room;

            this.container.addEventListener("click", function (event) {
                var action = event.target.closest("[data-action]");
                if (!action) {
                    return;
                }
                switch (action.getAttribute("data-action")) {
                case "toggle":
                    _this.controls.hidden = !_this.controls.hidden;
                    _this.toggle.setAttribute("aria-expanded", !_this.controls.hidden);
                    break;
                case "fold":
                    _this.open = !_this.open;
                    _this.updateFold();
                    break;
                case "mic":
                    _this.setMic(!(_this.me.mic || _this.asking.audio));
                    break;
                case "cam":
                    _this.setCam(action.getAttribute("data-mode"));
                    break;
                case "retry":
                    if (action.getAttribute("data-kind") === "audio") {
                        _this.setMic(true);
                    } else {
                        _this.setCam(_this.lastCam || "video");
                    }
                    break;
                case "sound":
                    _this.enableSound();
                    break;
                case "goto":
                    _this.options.onGoto(action.getAttribute("data-user"));
                    break;
                }
            });

            this.nameInput.addEventListener("change", function () {
                var name = _this.nameInput.value.trim();
                if (!name) {
                    _this.nameInput.value = _this.named ? _this.me.name : "";
                    return;
                }
                _this.setName(name);
                _this.options.onName(name);
            });

            this.asciiViewInput.addEventListener("change", function () {
                _this.asciiView = _this.asciiViewInput.checked;
                storage("klap.live.asciiView", _this.asciiView ? "1" : "0");
                Object.keys(_this.tiles).forEach(_this.updateTile, _this);
                _this.updateAsciiLoop();
            });

            window.addEventListener("beforeunload", function () {
                _this.stopTrack("audio");
                _this.stopTrack("video");
            });

            room.on("status", function (status) {
                _this.connection = status;
                _this.updateStatus();
            });
            room.on("users", function (users, joined) {
                Object.keys(_this.people).forEach(function (id) {
                    if (!users[id]) {
                        _this.removePerson(id);
                    }
                });
                Object.keys(users).forEach(function (id) {
                    if (id === room.id) {
                        return;
                    }
                    var person = _this.people[id] = _this.people[id] || {mic: false, cam: "off"};
                    person.name = users[id].name || person.name || "someone";
                    _this.updateTile(id);
                });
                if (joined.length) {
                    _this.sendState();
                }
                _this.updateStatus();
            });
            room.on("left", this.removePerson.bind(this));
            room.on("state", function (from, state) {
                var person = _this.people[from] = _this.people[from] || {};
                person.mic = !!state.mic;
                person.cam = state.cam;
                person.name = state.name || person.name;
                _this.updateTile(from);
                _this.updateAsciiLoop();
            });
            room.on("ascii", function (from, frame) {
                var tile = _this.tiles[from];
                if (tile && frame && typeof frame.f === "string") {
                    tile.pre.textContent = frame.f;
                }
            });
            room.on("stream", function (from, stream) {
                // tracks also end after their person has left the room
                var tile = _this.tiles[from] || _this.updateTile(from);
                if (!tile) {
                    return;
                }
                if (tile.video.srcObject !== stream) {
                    tile.video.srcObject = stream;
                    tile.audio.srcObject = stream;
                }
                tile.audio.play().catch(function () {
                    _this.soundBlocked = true;
                    _this.updateStatus();
                });
                _this.updateTile(from);
            });
        },

        // what changes outside the page: the size of the strip, permissions
        // given in the browser settings, devices plugged in
        watch: function () {
            var _this = this, root = this.container, devices = navigator.mediaDevices;

            // pages leave room for the strip (on a narrow screen it is at the bottom)
            if (window.ResizeObserver) {
                new ResizeObserver(function () {
                    document.documentElement.style.setProperty(
                        "--strip-height", root.offsetHeight + "px");
                }).observe(root);
            }

            ["audio", "video"].forEach(function (kind) {
                permissionStatus(kind).then(function (status) {
                    if (!status) {
                        return;
                    }
                    function check() {
                        var current = _this.problems[kind];
                        if (status.state === "denied") {
                            // say it before the person presses the button
                            _this.setProblem(kind, "blocked");
                        } else if (current && /^(blocked|refused|dismissed)$/.test(current.code)) {
                            _this.setProblem(kind, null);
                        }
                    }
                    status.onchange = check;
                    check();
                });
            });

            if (devices && devices.addEventListener) {
                devices.addEventListener("devicechange", function () {
                    ["audio", "video"].forEach(function (kind) {
                        var current = _this.problems[kind];
                        if (current && current.code === "missing") {
                            _this.setProblem(kind, null);
                        }
                    });
                });
            }
        },

        // also from the page, when the person gives the name there
        setName: function (name) {
            this.named = true;
            this.me.name = name;
            this.nameInput.value = name;
            this.room.setNick(name);
            this.sendState();
            this.updateControls();
            this.updateTile("me");
        },

        name: function (id) {
            var person = this.people[id];
            return person && person.name;
        },

        count: function () {
            return Object.keys(this.people).length + 1;
        },

        removePerson: function (id) {
            delete this.people[id];
            if (this.tiles[id]) {
                this.tiles[id].el.remove();
                delete this.tiles[id];
            }
            this.updateStatus();
        },

        updateFold: function () {
            this.container.classList.toggle("is-folded", !this.open);
            this.fold.setAttribute("aria-expanded", this.open);
            this.fold.textContent = interpolate(
                this.open ? gettext("hide people (%(count)s)") : gettext("show people (%(count)s)"),
                {count: this.count()}, true);
        },

        updateStatus: function () {
            var count = this.count(), status = this.status;
            if (this.connection === "live") {
                status.textContent = count === 1
                    ? gettext("only you :: send the address of this page to other people")
                    : interpolate(gettext("%(count)s here"), {count: count}, true);
            } else if (this.connection === "offline") {
                status.textContent = gettext("offline :: you can add reasons, but other people do not see your typing");
            } else {
                status.textContent = gettext("connecting…");
            }
            if (this.soundBlocked) {
                status.appendChild(document.createTextNode(" "));
                status.appendChild(button("link", gettext("enable sound"), "sound"));
            }
            this.updateFold();
        },

        enableSound: function () {
            var _this = this;
            this.soundBlocked = false;
            Object.keys(this.tiles).forEach(function (id) {
                if (id !== "me") {
                    _this.tiles[id].audio.play().catch(function () {});
                }
            });
            this.updateStatus();
        },

        sendState: function () {
            this.room.broadcast("state", {
                name: this.me.name, mic: this.me.mic, cam: this.me.cam
            });
        },

        updateTile: function (id) {
            var me = id === "me",
                person = me ? this.me : this.people[id];
            if (!person) {
                return null;
            }
            var tile = this.tiles[id];
            if (!tile) {
                tile = this.tiles[id] = {el: el("div", "tile")};
                tile.screen = el("div", "tile-screen");
                tile.pre = el("pre", "tile-ascii");
                tile.pre.setAttribute("aria-hidden", "true");
                tile.video = me ? this.localVideo : el("video");
                tile.video.playsInline = true;
                tile.video.autoplay = true;
                tile.video.muted = true;  // sound plays through tile.audio
                tile.audio = el("audio");
                tile.audio.autoplay = true;
                tile.initial = el("div", "tile-initial");
                tile.screen.appendChild(tile.video);
                tile.screen.appendChild(tile.pre);
                tile.screen.appendChild(tile.initial);
                tile.el.appendChild(tile.screen);
                if (!me) {
                    tile.el.appendChild(tile.audio);
                }
                tile.caption = el("div", "tile-caption");
                tile.el.appendChild(tile.caption);
                if (me) {
                    tile.el.classList.add("is-me");
                    this.tilesEl.insertBefore(tile.el, this.tilesEl.firstChild);
                } else {
                    this.tilesEl.appendChild(tile.el);
                }
            }

            var name = person.name || "someone",
                hasVideo = me ? !!this.camTrack : tile.video.srcObject &&
                    tile.video.srcObject.getVideoTracks().some(function (t) {
                        return t.readyState === "live" && !t.muted;
                    }),
                mode = person.cam === "video" && hasVideo
                    ? (this.asciiView ? "ascii-local" : "video")
                    : person.cam === "ascii" ? "ascii" : "off";

            tile.el.setAttribute("data-mode", mode);
            tile.initial.textContent = name.charAt(0).toUpperCase();

            tile.caption.textContent = "";
            tile.caption.appendChild(el("span", "tile-name", me ? interpolate(gettext("%(name)s (you)"), {name: name}, true) : name));
            tile.caption.appendChild(el("span", "tile-mic" + (person.mic ? " is-on" : ""),
                                        person.mic ? gettext("mic on") : gettext("muted")));
            var writing = this.options.writingLabel(id);
            if (writing) {
                var go = button("tile-writing link", writing, me ? null : "goto");
                go.setAttribute("data-user", id);
                tile.caption.appendChild(go);
            }
            return tile;
        },

        updateControls: function () {
            var mic = this.micButton, asking = this.asking;
            mic.textContent = asking.audio ? gettext("microphone: asking…")
                : this.me.mic ? gettext("microphone: on") : gettext("microphone: off");
            mic.setAttribute("aria-pressed", this.me.mic);
            this.camLabel.textContent = asking.video ? gettext("camera: asking…") : gettext("camera:");
            Object.keys(this.camButtons).forEach(function (mode) {
                this.camButtons[mode].setAttribute("aria-pressed", this.me.cam === mode);
            }, this);
            this.nameLabel.classList.toggle("is-missing", !this.named);
            this.renderProblem("audio");
            this.renderProblem("video");
        },

        // code: a key of PROBLEMS, or null when the device is fine
        setProblem: function (kind, code, detail) {
            this.problems[kind] = code ? {code: code, detail: detail} : null;
            this.renderProblem(kind);
        },

        renderProblem: function (kind) {
            var line = this.statusEls[kind], current = this.problems[kind],
                code = this.asking[kind] ? "asking" : current && current.code;
            line.textContent = "";
            line.hidden = !code;
            line.classList.toggle("is-error", !!code && code !== "asking");
            if (!code) {
                return;
            }
            line.appendChild(document.createTextNode(interpolate(
                PROBLEMS[kind][code] || PROBLEMS[kind].other,
                {error: current && current.detail || ""}, true)));
            if (code !== "asking" && code !== "silent" && code !== "insecure") {
                var retry = button("link", gettext("try again"), "retry");
                retry.setAttribute("data-kind", kind);
                line.appendChild(document.createTextNode(" "));
                line.appendChild(retry);
            }
        },

        // ask for a device, and show what happens while the person waits
        request: function (kind) {
            var _this = this;
            this.asking[kind] = true;
            this.updateControls();
            return acquire(kind).then(function (track) {
                _this.asking[kind] = false;
                _this.setProblem(kind, null);
                return track;
            }, function (error) {
                _this.asking[kind] = false;
                _this.setProblem(kind, error.code, error.detail);
                _this.updateControls();
                throw error;
            });
        },

        // a device that stops by itself: unplugged, or taken by the system
        guard: function (kind, track) {
            var _this = this;
            track.addEventListener("ended", function () {
                var mine = kind === "video" ? _this.camTrack : _this.room.tracks.audio;
                if (mine !== track) {
                    return;
                }
                _this.stopTrack(kind);
                if (kind === "video") {
                    _this.wanted.video = "off";
                    _this.me.cam = "off";
                } else {
                    _this.wanted.audio = false;
                    _this.me.mic = false;
                }
                _this.afterMediaChange();
                _this.setProblem(kind, "lost");
            });
            if (kind === "audio") {
                track.addEventListener("mute", function () {
                    if (_this.room.tracks.audio === track) {
                        _this.setProblem("audio", "silent");
                    }
                });
                track.addEventListener("unmute", function () {
                    var current = _this.problems.audio;
                    if (current && current.code === "silent") {
                        _this.setProblem("audio", null);
                    }
                });
            }
        },

        setMic: function (on) {
            var _this = this;
            this.wanted.audio = on;
            if (!on) {
                this.stopTrack("audio");
                this.me.mic = false;
                this.afterMediaChange();
                return;
            }
            if (this.asking.audio || this.me.mic) {
                return;
            }
            this.request("audio").then(function (track) {
                if (!_this.wanted.audio) {
                    track.stop();  // switched off while the browser was asking
                    _this.updateControls();
                    return;
                }
                _this.guard("audio", track);
                _this.room.setTrack("audio", track);
                _this.me.mic = true;
                _this.afterMediaChange();
                _this.enableSound();
                if (track.muted) {
                    _this.setProblem("audio", "silent");
                }
            }).catch(function () {});
        },

        setCam: function (mode) {
            var _this = this;
            this.wanted.video = mode;
            if (mode === "off") {
                this.stopTrack("video");
                this.me.cam = "off";
                this.afterMediaChange();
                return;
            }
            this.lastCam = mode;
            if (this.asking.video) {
                return;  // the answer uses the last mode the person chose
            }
            var ready = this.camTrack ? Promise.resolve(this.camTrack)
                : this.request("video").then(function (track) {
                    if (_this.wanted.video === "off") {
                        track.stop();
                        _this.updateControls();
                        return null;
                    }
                    _this.guard("video", track);
                    _this.camTrack = track;
                    _this.localVideo.srcObject = new MediaStream([track]);
                    return track;
                });
            ready.then(function (track) {
                if (!track) {
                    return;
                }
                _this.me.cam = _this.wanted.video;
                // in ascii mode the camera image stays here; only text frames go out
                _this.room.setTrack("video", _this.me.cam === "video" ? track : null);
                _this.afterMediaChange();
                _this.enableSound();
            }).catch(function () {});
        },

        stopTrack: function (kind) {
            var track = kind === "video" ? this.camTrack : this.room.tracks.audio;
            if (kind === "video") {
                this.camTrack = null;
                this.localVideo.srcObject = null;
            }
            this.room.setTrack(kind, null);
            if (track) {
                track.stop();
            }
        },

        afterMediaChange: function () {
            this.updateControls();
            this.updateTile("me");
            this.sendState();
            this.updateAsciiLoop();
        },

        // render ascii for our own camera (sent to the others) and, when
        // "show all video as ascii" is on, for incoming video
        updateAsciiLoop: function () {
            var _this = this,
                needed = this.me.cam === "ascii" || (this.asciiView && Object.keys(this.people)
                    .some(function (id) { return _this.people[id].cam === "video"; }));
            if (needed && !this.asciiTimer) {
                this.asciiTimer = setInterval(this.asciiFrame.bind(this), 1000 / ASCII_FPS);
            } else if (!needed && this.asciiTimer) {
                clearInterval(this.asciiTimer);
                this.asciiTimer = null;
            }
        },

        asciiFrame: function () {
            var _this = this;
            if (document.hidden) {
                return;
            }
            this.frameCount++;
            if (this.me.cam === "ascii" && this.camTrack) {
                var frame = this.renderer.render(this.localVideo);
                if (frame) {
                    this.tiles.me.pre.textContent = frame;
                    this.room.sendFrame("ascii", {f: frame},
                                        this.frameCount % RELAY_EVERY === 0);
                }
            }
            if (this.asciiView) {
                Object.keys(this.tiles).forEach(function (id) {
                    var tile = _this.tiles[id];
                    if (tile.el.getAttribute("data-mode") === "ascii-local") {
                        var local = _this.renderer.render(tile.video);
                        if (local) {
                            tile.pre.textContent = local;
                        }
                    }
                });
            }
        }
    };

    assembly.Presence = Presence;
})(window.arguman = window.arguman || {});
