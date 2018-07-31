"use strict";

const SECONDARY_PEN_BUTTON = 1 << 5;

class Canvas {
    constructor(width, height) {
        this.element = document.createElement("canvas");
        this.context = this.element.getContext("2d");
        this.draw = new Draw(this.context);

        const z = Canvas.PIXEL_RATIO;
        [this.element.width, this.element.height] = [width * z, height * z];
        [this.element.style.width, this.element.style.height] = [`${width}px`, `${height}px`];
        this.clear();
    }

    clear() {
        this.context.fillStyle = "white";
        this.context.fillRect(0, 0, this.element.width, this.element.height);
    }
}
Canvas.PIXEL_RATIO = window.devicePixelRatio;

class Draw {
    constructor(context) {
        this.context = context;
        this._colour = this.context.fillStyle;

        this.context.stokeStyle = this._colour;
    }

    get colour() {
        return this._colour;
    }
    set colour(colour) {
        this._colour = colour;
        this.context.fillStyle = this.context.strokeStyle = this._colour;
    }

    circle(x, y, r) {
        const z = Canvas.PIXEL_RATIO;
        this.context.beginPath();
        this.context.arc(x * z, y * z, r * z, 0, 2 * Math.PI, false);
        this.context.fill();
    }

    // Smoothly connect two circles by computing their outer tangent lines.
    connect_circles(x0, y0, r0, x1, y1, r1) {
        const z = Canvas.PIXEL_RATIO;

        if (r0 === r1) {
            this.context.beginPath();
            this.context.moveTo(x0 * z, y0 * z);
            this.context.lineTo(x1 * z, y1 * z);
            this.context.lineWidth = 2 * r0 * z;
            this.context.stroke();
        } else {
            if (r0 < r1) {
                [x0, y0, r0, x1, y1, r1] = [x1, y1, r1, x0, y0, r0];
            }

            const xp = (x1 * r0 - x0 * r1) / (r0 - r1);
            const yp = (y1 * r0 - y0 * r1) / (r0 - r1);

            const tangent_coord = (a, ap, b, bp, r, s) => {
                return a + (r ** 2 * (ap - a) + s * r * (bp - b) * Math.sqrt((ap - a) ** 2 + (bp - b) ** 2 - r ** 2)) / ((ap - a) ** 2 + (bp - b) ** 2);
            };
            const tangent_point = (x, y, r, s) => {
                return [tangent_coord(x, xp, y, yp, r, s), tangent_coord(y, yp, x, xp, r, -s)];
            };
            const tangent_triple = (x, y, r) => {
                return [tangent_point(x, y, r, 1), [x, y], tangent_point(x, y, r, -1)];
            };

            this.context.beginPath();
            tangent_triple(x0, y0, r0).map(([x, y]) => this.context.lineTo(x * z, y * z));
            tangent_triple(x1, y1, r1).reverse().map(([x, y]) => this.context.lineTo(x * z, y * z));
            this.context.closePath();
            this.context.fill();
        }
    }

    gradient(x0, y0, c0, x1, y1, c1) {
        const z = Canvas.PIXEL_RATIO;
        const grad = this.context.createLinearGradient(x0 * z, y0 * z, x1 * z, y1 * z);
        grad.addColorStop(0, c0);
        grad.addColorStop(1, c1);
        return grad;
    }
}

// A container for pointer state (see `Pen`).
class PenState {
    constructor(x, y, pressure) {
        this.x = x;
        this.y = y;
        this.pressure = pressure;
        this.colour = "black";
    }

    static from_event(event, element) {
        const rect = element.getBoundingClientRect();
        return new PenState(
            event.pageX - window.scrollX - rect.left,
            event.pageY - window.scrollY - rect.top,
            event.pressure,
        );
    }

    clone() {
        const state = new PenState(this.x, this.y, this.pressure);
        state.colour = this.colour;
        return state;
    }
}

// A class for recording the state of the pointer (position, pressure
// and colour) at a given point in time. Useful for interpolation.
class Pen {
    constructor() {
        this.state = null;
    }
    get held() {
        return this.state !== null;
    }
    changed(now) {
        return (
            now.x !== this.state.x ||
            now.y !== this.state.y ||
            now.pressure !== this.state.pressure ||
            now.colour !== this.state.colour
        );
    }
}

// An action that can be triggered by a button.
class Action {
    constructor(name, action) {
        this.action = action;
        this.element = document.createElement("li");
        this.element.appendChild(document.createTextNode(name));
        this.element.addEventListener("pointerdown", this.action);
        this.element.addEventListener("mousedown", (event) => this.action(event, true));
    }
}

let tools = [];

// A tool that can be selected.
class Tool extends Action {
    constructor(name, properties) {
        super(name, (event, stylus_button) => {
            event.preventDefault();
            if (event.buttons & SECONDARY_PEN_BUTTON || stylus_button || event.shiftKey) {
                // If we select the tool while holding the pen button,
                // then we're going to toggle the tool *without affecting*
                // the currently-selected tools. This means we can have
                // multiple tools active at once. This is useful for
                // colour blending, for example.
                this.active = !this.active;
            } else {
                // If we just select the tool (without holding anything),
                // then we're going to deselect all other tools first.
                let deselected_others = false;
                for (const tool of Object.values(tools)) {
                    if (tool !== this) {
                        // If this tool is already active, we avoid
                        // deactivating it and then activating it again,
                        // in case of any side-effects.
                        if (tool.active) {
                            deselected_others = true;
                            tool.active = false;
                        }
                    }
                }
                this.active = deselected_others || !this.active;
            }
        });

        this.hue = null;
        Object.assign(this, properties);
        if (this.hue !== null) {
            this.element.style.setProperty("--active-colour", `hsl(${this.hue}, 75%, 50%)`);
        }
    }

    get active() {
        return this.element.classList.contains("active");
    }
    set active(activate) {
        if (this.active !== activate) {
            if (activate) {
                this.element.classList.add("active");
            } else {
                this.element.classList.remove("active");
            }
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const canvas = new Canvas(640, 480);
    document.body.appendChild(canvas.element);

    const pen = new Pen();

    const MIN_STROKE_RADIUS = 5;
    const MAX_STROKE_RADIUS = 40;
    const ALT_STROKE_COLOUR = "white";
    const SCROLL_DAMPENING = 40;

    let stroke_radius = 10;

    tools = {
        red: new Tool("Red", { hue: 0 }),
        green: new Tool("Green", { hue: 110 }),
        blue: new Tool("Blue", { hue: 230 }),
    };

    const pen_state_from_event = (event) => {
        const state = PenState.from_event(event, canvas.element);
        const hues = [];
        for (const tool of Object.values(tools)) {
            if (tool.hue !== null && tool.active) {
                hues.push(tool.hue);
            }
        }
        if (hues.length > 0) {
            // Compute the average hue (i.e. a circular mean).
            let [x, y] = hues
                .map((d) => d * Math.PI / 180)
                .map((r) => [Math.sin(r), Math.cos(r)])
                .reduce(([ax, ay], [bx, by]) => [ax + bx, ay + by], [0, 0]);
            const hue = Math.atan2(x, y) * 180 / Math.PI;
            state.colour = `hsl(${hue}, 75%, 50%)`;
        }
        return state;
    };

    const pointer_down = (event, stylus_button) => {
        if (event.button === 0) {
            event.preventDefault();
            pen.state = pen_state_from_event(event);
            if (event.buttons & SECONDARY_PEN_BUTTON || stylus_button || event.shiftKey) {
                // For some reason, the `mousedown` event doesn't properly
                // capture `event.buttons` consistently with `pointermove`,
                // so we have to override it with `stylus_button` here.
                pen.state.colour = ALT_STROKE_COLOUR;
            }
            canvas.draw.colour = pen.state.colour;
            canvas.draw.circle(pen.state.x, pen.state.y, pen.state.pressure * stroke_radius);
        }
    };

    const pointer_move = (event, stylus_button) => {
        event.preventDefault();
        if (pen.held) {
            const now = pen_state_from_event(event);
            if (event.buttons & SECONDARY_PEN_BUTTON || stylus_button || event.shiftKey) {
                now.colour = ALT_STROKE_COLOUR;
            }

            if (pen.changed(now)) {
                // We smoothly interpolate both the size and colour of the stroke,
                // so even if the user moves the pointer quickly, it should still
                // result in a smooth line. We *don't* yet interpolate the lines,
                // so the result does occasionally appear piecewise-linear, but
                // it looks fine.
                canvas.draw.colour = canvas.draw.gradient(
                    pen.state.x, pen.state.y, pen.state.colour,
                    now.x, now.y, now.colour
                );
                canvas.draw.circle(pen.state.x, pen.state.y, pen.state.pressure * stroke_radius);
                canvas.draw.circle(now.x, now.y, now.pressure * stroke_radius);
                canvas.draw.connect_circles(
                    pen.state.x, pen.state.y, pen.state.pressure * stroke_radius,
                    now.x, now.y, now.pressure * stroke_radius,
                );
            }

            pen.state = now;
        }
    };

    const pointer_up = (event) => {
        if (event.button === -1 || event.button === 0) {
            event.preventDefault();
            pen.state = null;
        }
    };

    // Events for stylus events while holding the primary button on a stylus.
    // For some reason, these trigger as mouse events instead of pointer events.
    // Note: these are *not* actual mouse events, which will go through the pointer
    // events.
    canvas.element.addEventListener("mousedown", (event) => pointer_down(event, true));
    window.addEventListener("mouseup", pointer_up);

    // One unfortunate consequence of the Pointer APIs is that `pointerdown`
    // fires only when the pointer becomes active (i.e is first pressed down).
    // No events fire if the pointer stays stationary after becoming active, even
    // if other attributes, such as pressure, change.
    // `pointermove` seems to trigger either when the pointer moves, or when an
    // attribute changes *as long as the pointer has moved since it originally
    // became active*. So the only case we can't catch is if the user varies the
    // pressure after initially pressing the stylus, but doesn't move it.
    canvas.element.addEventListener("pointerdown", pointer_down);

    // This catches all pointer movement (no need for mousemove).
    // Note that we attach this to the window (though the initial `pointerdown`
    // event is on the canvas itself), so even if we move the pointer off the
    // canvas, we can continue drawing when the pointer returns to the canvas.
    window.addEventListener("pointermove", pointer_move);

    // The pointer is lifted without holding any stylus buttons. This includes
    // what would usually be considered `mouseup`.
    window.addEventListener("pointerup", pointer_up);

    // If the stylus is deactivated, we want to treat it as lifting the stylus.
    canvas.element.addEventListener("pointercancel", pointer_up);

    // Tool panel.
    const tool_panel = document.createElement("ul");
    for (const tool of Object.values(tools)) {
        tool_panel.appendChild(tool.element);
    }
    document.body.appendChild(tool_panel);

    // Action panel.
    const action_panel = document.createElement("ul");
    action_panel.appendChild(new Action("Clear", () => canvas.clear()).element);
    document.body.appendChild(action_panel);

    // We display a range to allow the user to change the range of stroke sizes.
    const stroke_range = document.createElement("input");
    stroke_range.type = "range";
    stroke_range.min = MIN_STROKE_RADIUS;
    stroke_range.max = MAX_STROKE_RADIUS;
    stroke_range.value = stroke_radius;
    stroke_range.addEventListener("input", () => {
        stroke_radius = parseInt(stroke_range.value);
    });
    const range_wrapper = document.createElement("div");
    range_wrapper.appendChild(stroke_range);
    document.body.appendChild(stroke_range);

    // The user can also change the range of stroke sizes by scrolling (or using
    // the secondary button and dragging using a stylus).
    window.addEventListener("wheel", (event) => {
        event.preventDefault();
        stroke_range.value = Math.round(stroke_radius - event.wheelDeltaY / SCROLL_DAMPENING);
        stroke_radius = parseInt(stroke_range.value);
    });
});
