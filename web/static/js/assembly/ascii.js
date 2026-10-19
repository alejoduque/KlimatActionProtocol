// Ascii video for assemblies, after hasciicam (https://github.com/dyne/hasciicam)
// by Jaromil, which renders live video with AA-lib.
//
// Same pipeline as hasciicam: frame -> BT.601 integer luma (frame_convert.c)
// -> AA-lib's palette table (bright, contrast, gamma, inversion, as in
// aarender.c) -> Floyd-Steinberg error diffusion -> characters. AA-lib picks
// characters by matching 2x2 pixel cells against a rasterised font; here a
// brightness-ordered ramp stands in for the font, which keeps the renderer a
// few lines of JavaScript with no WebAssembly build.
//
// In "ascii" camera mode only these text frames leave the browser: the
// camera image itself is never sent to anyone.

(function (arguman) {
    "use strict";

    var assembly = arguman.assembly = arguman.assembly || {};

    var RAMP = " .,:;irsXA253hMHGS#9B&@";

    // width / height of a monospace character cell
    var CELL_ASPECT = 0.55;

    function Renderer(options) {
        options = options || {};
        this.cols = options.cols || 72;
        this.ramp = options.ramp || RAMP;
        this.dither = options.dither !== false;
        this.canvas = document.createElement("canvas");
        this.context = this.canvas.getContext("2d", {willReadFrequently: true});
        this.setParams(options.bright || 0, options.contrast || 0,
                       options.gamma || 1.0, options.inversion || false);
    }

    Renderer.prototype = {
        // the AA-lib render parameters (aa_renderparams)
        setParams: function (bright, contrast, gamma, inversion) {
            var table = this.table = new Uint8Array(256), i, y;
            for (i = 0; i < 256; i++) {
                y = Math.max(0, Math.min(255, i + bright));
                if (contrast) {
                    y = y < contrast ? 0 : y > 256 - contrast ? 255 :
                        (y - contrast) * 255 / (255 - 2 * contrast);
                }
                if (gamma !== 1.0) {
                    y = Math.pow(y / 255, gamma) * 255 + 0.5;
                }
                if (inversion) {
                    y = 255 - y;
                }
                table[i] = Math.max(0, Math.min(255, y | 0));
            }
        },

        // returns the frame as rows of text, or null if the video has no
        // picture yet
        render: function (video, mirror) {
            var width = video.videoWidth, height = video.videoHeight;
            if (!width || !height) {
                return null;
            }
            var cols = this.cols,
                rows = Math.max(1, Math.round(cols * height / width * CELL_ASPECT)),
                context = this.context;

            if (this.canvas.width !== cols || this.canvas.height !== rows) {
                this.canvas.width = cols;
                this.canvas.height = rows;
            }
            context.save();
            if (mirror) {
                context.translate(cols, 0);
                context.scale(-1, 1);
            }
            // the browser's downscale averages the pixels of each cell
            context.drawImage(video, 0, 0, cols, rows);
            context.restore();

            var pixels = context.getImageData(0, 0, cols, rows).data,
                levels = this.ramp.length - 1,
                errors = this.dither ? new Float32Array((cols + 2) * 2) : null,
                lines = new Array(rows),
                x, y, i, value, level, error, line, current, next;

            for (y = 0; y < rows; y++) {
                line = "";
                if (errors) {
                    current = (y % 2) * (cols + 2);
                    next = ((y + 1) % 2) * (cols + 2);
                    errors.fill(0, next, next + cols + 2);
                }
                for (x = 0; x < cols; x++) {
                    i = (y * cols + x) * 4;
                    value = this.table[
                        (77 * pixels[i] + 150 * pixels[i + 1] +
                         29 * pixels[i + 2]) >> 8];
                    if (errors) {
                        value += errors[current + x + 1];
                    }
                    level = Math.max(0, Math.min(levels,
                        Math.round(value * levels / 255)));
                    if (errors) {
                        error = value - level * 255 / levels;
                        errors[current + x + 2] += error * 7 / 16;
                        errors[next + x] += error * 3 / 16;
                        errors[next + x + 1] += error * 5 / 16;
                        errors[next + x + 2] += error / 16;
                    }
                    line += this.ramp[level];
                }
                lines[y] = line;
            }
            return lines.join("\n");
        }
    };

    assembly.ascii = {
        Renderer: Renderer,
        RAMP: RAMP
    };
})(window.arguman = window.arguman || {});
