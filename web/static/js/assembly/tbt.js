// Time Based Text for assembly drafts.
//
// After TBT by Jaromil and rgareus (https://github.com/dyne/TBT, GPL):
// "record performance time in text and vehicle it as additional
// information". A textarea is edited with the mouse, paste and selections,
// not only key by key, so the recording keeps one entry per edit:
//
//     [delay_ms, position, delete_count, inserted_text]
//
// toTBT() converts it to TBT's own [key, msec] entries, which
// tbt-typewriter.js plays, and toTBTFile() to the binary .tbt format read by
// the tbt command line player (pairs of little-endian uint64).

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    // TBT key codes (src/slw/keycodes.h)
    var KEY_BACKSPACE = 8,
        KEY_LEFT = 259,
        KEY_RIGHT = 260;

    function splice(text, entry) {
        return text.slice(0, entry[1]) + entry[3] +
            text.slice(entry[1] + entry[2]);
    }

    function Recorder() {
        this.reset("");
    }

    Recorder.prototype = {
        reset: function (text) {
            this.entries = [];
            this.drained = 0;
            this.value = text || "";
            this.last = Date.now();
        },
        // call after every change of the textarea value
        update: function (value) {
            var old = this.value, prefix = 0, suffix = 0, now = Date.now();
            if (value === old) {
                return;
            }
            while (prefix < old.length && prefix < value.length &&
                   old[prefix] === value[prefix]) {
                prefix++;
            }
            while (suffix < old.length - prefix &&
                   suffix < value.length - prefix &&
                   old[old.length - 1 - suffix] ===
                   value[value.length - 1 - suffix]) {
                suffix++;
            }
            this.entries.push([
                now - this.last,
                prefix,
                old.length - prefix - suffix,
                value.slice(prefix, value.length - suffix)
            ]);
            this.value = value;
            this.last = now;
        },
        recording: function () {
            return this.entries.slice();
        },
        // the entries recorded since the last drain, to stream them live
        drain: function () {
            var from = this.drained || 0;
            this.drained = this.entries.length;
            return this.entries.slice(from);
        }
    };

    // Plays a live stream of entries as they arrive, each after its own
    // recorded delay, so the others see a text typed at the pace it was
    // typed, hesitations and corrections included. When the stream falls
    // behind (a long paste of entries, a slow tab) it speeds up so it never
    // lags much behind the writer. render(text, caret) draws each step.
    function Stream(render, options) {
        options = options || {};
        this.render = render;
        this.maxPause = options.maxPause || 2500;
        this.maxLag = options.maxLag || 1500;
        this.queue = [];
        this.text = "";
        this.caret = 0;
        this.target = null;
        this.timer = null;
    }

    Stream.prototype = {
        // jump to a known state, dropping what was still queued
        reset: function (text, caret) {
            this.stop();
            this.queue = [];
            this.text = text || "";
            this.caret = caret === undefined ? this.text.length : caret;
            this.target = null;
            this.render(this.text, this.caret);
        },
        // entries to perform, and the text they should end in
        push: function (entries, target) {
            Array.prototype.push.apply(this.queue, entries || []);
            this.target = typeof target === "string" ? target : null;
            if (!this.timer) {
                this.schedule();
            }
        },
        schedule: function () {
            var _this = this, maxPause = this.maxPause;
            if (!this.queue.length) {
                this.timer = null;
                // never end on a wrong text, whatever was lost on the way
                if (this.target !== null && this.target !== this.text) {
                    this.reset(this.target);
                }
                return;
            }
            var lag = this.queue.reduce(function (sum, entry) {
                    return sum + Math.min(entry[0], maxPause);
                }, 0),
                speed = Math.max(1, lag / this.maxLag);
            this.timer = setTimeout(function () {
                _this.step();
            }, Math.min(this.queue[0][0], maxPause) / speed);
        },
        step: function () {
            var entry = this.queue.shift();
            if (entry[1] + entry[2] <= this.text.length) {
                this.text = splice(this.text, entry);
                this.caret = entry[1] + entry[3].length;
                this.render(this.text, this.caret);
            }
            this.schedule();
        },
        stop: function () {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
        }
    };

    // Plays a recording into target, drawing the caret like
    // tbt-typewriter.js does. target is an element or a function returning
    // the element to draw in, for pages that re-render during playback.
    // Pauses longer than maxPause are shortened so a long hesitation reads
    // as a hesitation, not as a frozen page.
    // Returns a function that stops the playback.
    function play(recording, target, options) {
        options = options || {};
        var speed = options.speed || 1,
            maxPause = options.maxPause || 2500,
            text = "", index = 0, timer = null;

        function render(caret) {
            var element = typeof target === "function" ? target() : target;
            if (!element) {
                return;
            }
            element.textContent = "";
            element.appendChild(document.createTextNode(text.slice(0, caret)));
            var cursor = document.createElement("span");
            cursor.className = "tbt-caret";
            element.appendChild(cursor);
            element.appendChild(document.createTextNode(text.slice(caret)));
        }

        function feed() {
            var entry = recording[index];
            text = splice(text, entry);
            render(entry[1] + entry[3].length);
            index++;
            if (index < recording.length) {
                schedule();
            } else {
                timer = null;
                options.onEnd && options.onEnd(text);
            }
        }

        function schedule() {
            var delay = Math.min(recording[index][0], maxPause) / speed;
            timer = setTimeout(feed, delay);
        }

        render(0);
        if (recording.length) {
            schedule();
        } else {
            options.onEnd && options.onEnd(text);
        }

        return function stop() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };
    }

    // [[key, msec], ...] as recorded by the original TBT
    function toTBT(recording) {
        var keys = [], cursor = 0;

        function press(key, delay) {
            keys.push([key, delay]);
        }

        recording.forEach(function (entry) {
            var delay = entry[0], target = entry[1] + entry[2], i;
            function next() {
                var d = delay;
                delay = 0;  // the pause belongs to the first key of an edit
                return d;
            }
            while (cursor < target) { press(KEY_RIGHT, next()); cursor++; }
            while (cursor > target) { press(KEY_LEFT, next()); cursor--; }
            for (i = 0; i < entry[2]; i++) {
                press(KEY_BACKSPACE, next());
                cursor--;
            }
            for (i = 0; i < entry[3].length; i++) {
                press(entry[3].charCodeAt(i), next());
                cursor++;
            }
        });
        return keys;
    }

    function toTBTFile(recording) {
        var keys = toTBT(recording),
            buffer = new ArrayBuffer(keys.length * 16),
            view = new DataView(buffer);
        keys.forEach(function (key, i) {
            view.setBigUint64(i * 16, BigInt(key[0]), true);
            view.setBigUint64(i * 16 + 8, BigInt(key[1]), true);
        });
        return new Blob([buffer], {type: "application/octet-stream"});
    }

    function replay(recording) {
        return recording.reduce(splice, "");
    }

    assembly.tbt = {
        Recorder: Recorder,
        Stream: Stream,
        play: play,
        replay: replay,
        toTBT: toTBT,
        toTBTFile: toTBTFile
    };
})(window.arguman = window.arguman || {});
