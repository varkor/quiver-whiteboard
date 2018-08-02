"use strict";

class MessageError extends Error {}

class Client {
    constructor(delegate) {
        this.ws = null;
        this.delegate = delegate;
    }

    static validate_data(sig, data) {
        const properties = new Set(Object.keys(data));
        for (const [key, validator] of Object.entries(sig)) {
            if (properties.delete(key)) {
                if (!validator(data[key])) {
                    // The data value did not pass the validation test. Reject it.
                    return false;
                }
            } else {
                // The data did not include a required field. Reject it.
                return false;
            }
        }
        if (properties.size !== 0) {
            // The data included fields that were not present in the signature. Reject it.
            return false;
        }
        return true;
    }

    connect(host, port) {
        if (/^[a-z0-9\.\-]+$/i.test(host) && /^[0-9]+$/.test(port)) {
            this.ws = new WebSocket(`wss://${host}:${port}`);
        } else {
            console.error(`Tried to connect to an invalid host or port: ${host}:${port}`);
            return;
        }

        const SECOND = 1000;
        const timeout = setTimeout(() => {
            console.error("WebSocket timed out while attempting to connect to the server.");
            this.ws.close();
        }, 5 * SECOND);

        this.ws.addEventListener("open", () => {
            clearTimeout(timeout);
            this.delegate.connect();
            this.ws.send(JSON.stringify({
                kind: "join",
                channel: "all",
            }));
        });

        this.ws.addEventListener("message", (message) => {
            try {
                const data = JSON.parse(message.data);
                this.receive_message(data);
            } catch (error) {
                // Received bad message from server. This doesn't necessarily mean the server's
                // misbehaving (though who's to say it's not?). We might also get errors with faulty
                // connections. We're just going to ignore them, though.
                console.error(message, error);
            }
        });

        this.ws.addEventListener("close", () => {
            this.delegate.disconnect();
            console.log("WebSocket connection closed.");
        });
    }

    receive_message(data) {
        // console.log("Received data:", data);
        switch (data.kind) {
            case "channel":
            this.delegate.join();
                const canvas = data.canvas;
                if (Array.isArray(canvas)) {
                    for (const action of canvas) {
                        this.delegate.draw(action, true);
                    }
                    return;
                } else {
                    // The server sent us malformed channel data.
                }
                return;
            case "draw":
                this.delegate.draw(data, true);
                return;
        }
        // All valid arms of the switch return early, so if we get here, then something
        // must be wrong with the message data.
        throw new MessageError();
    }

    send_message(data) {
        if (this.ws.readyState === this.ws.OPEN) {
            // console.log("Sent data:", data);
            if (data.kind === "draw") {
                // We forward any drawing messages directly to the client, so that we
                // can modify the canvas locally without any delay. The Painter's
                // Algorithm will ensure that we end up with the correct result in the
                // end, because we'll re-draw the data when we receive it from the
                // server as well.
                this.delegate.draw(data, false);
            }
            this.ws.send(JSON.stringify(data));
        } else {
            // We should be able to delay sending messages until the WebSocket is ready,
            // but for now, we'll simply ignore the message. It should be prevented by
            // the UI, anyway.
            console.error("WebSocket wasn't ready for data:", data);
        }
    }
}

const SECONDARY_PEN_BUTTON = 1 << 5;

class Canvas {
    constructor(width, height, background) {
        this.element = document.createElement("canvas");
        this.context = this.element.getContext("2d");
        this.draw = new Draw(this.context);
        this.background = background;

        const z = Canvas.PIXEL_RATIO;
        [this.element.width, this.element.height] = [width * z, height * z];
        [this.element.style.width, this.element.style.height] = [`${width}px`, `${height}px`];
        this.clear();
    }

    clear() {
        if (this.background !== null) {
            this.context.fillStyle = this.background;
            this.context.fillRect(0, 0, this.element.width, this.element.height);
        } else {
            this.context.clearRect(0, 0, this.element.width, this.element.height);
        }
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

    circle(x, y, r, fill = true) {
        const z = Canvas.PIXEL_RATIO;
        this.context.beginPath();
        this.context.arc(x * z, y * z, r * z, 0, 2 * Math.PI, false);
        if (fill) {
            this.context.fill();
        } else {
            this.context.stroke();
        }
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
    constructor(x, y, pressure, pointerType) {
        this.x = x;
        this.y = y;
        this.tool = "brush";
        this.colour = "black";
        this.pressure = pressure;
        this.stroke_radius = 10;
        this.pointerType = pointerType;
    }

    static from_event(event, element) {
        const rect = element.getBoundingClientRect();
        return new PenState(
            event.pageX - window.scrollX - rect.left,
            event.pageY - window.scrollY - rect.top,
            event.pressure,
            event.pointerType,
        );
    }

    as_message() {
        return {
            x: this.x,
            y: this.y,
            tool: this.tool,
            colour: this.colour,
            radius: this.pressure * this.stroke_radius,
        };
    }
}

// A class for recording the state of the pointer (position, pressure
// and colour) at a given point in time. Useful for interpolation.
class Pen {
    constructor() {
        this.state = null;
        this.held = false;
    }

    changed(now) {
        return (
            now.x !== this.state.x ||
            now.y !== this.state.y ||
            now.tool !== this.state.tool ||
            now.pressure !== this.state.pressure ||
            now.colour !== this.state.colour ||
            now.stroke_radius !== this.state.stroke_radius
        );
    }
}

// An action that can be triggered by a button.
class Action {
    constructor(name, action) {
        this.action = action;
        this.element = document.createElement("li");
        this.element.appendChild(document.createTextNode(name));
        this.element.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            this.action(event);
        });
        this.element.addEventListener("mousedown", (event) => {
            event.preventDefault();
            this.action(event, true);
        });
    }
}

let tools = [];

// A tool that can be selected.
class Tool extends Action {
    constructor(name, properties) {
        super(name, (event, stylus_button) => {
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
    const connecting_overlay = document.createElement("div");
    connecting_overlay.classList.add("overlay");
    connecting_overlay.dataset.descr = "Connecting...";
    document.body.appendChild(connecting_overlay);

    const canvas = new Canvas(640, 480, "white");
    document.body.appendChild(canvas.element);

    const brush_layer = new Canvas(640, 480, null);
    brush_layer.element.classList.add("noninteractive");
    document.body.appendChild(brush_layer.element);

    const client = new Client({
        connect() {
            connecting_overlay.dataset.descr = "Loading canvas...";
        },

        disconnect() {
            if (connecting_overlay.classList.contains("hidden")) {
                connecting_overlay.classList.remove("hidden");
                connecting_overlay.dataset.descr = "Disconnected from server. Please try refreshing.";
            } else {
                connecting_overlay.dataset.descr = "Could not connect to server. Please try refreshing.";
            }
        },

        join() {
            connecting_overlay.classList.add("hidden");
        },

        draw(data, from_server) {
            // FIXME: the validation is currently duplicated on the client and server. Ideally we
            // would use `import` to share this functionality.
            const validate_data = (properties) => {
                return Client.validate_data(Object.assign({
                    kind: () => true, // We're already implicitly validating this property here.
                    shape: () => true, // As above.
                }, properties), data);
            };

            const validate_pen_state = (state) => {
                return Client.validate_data({
                    x: (x) => Number.isFinite(x),
                    y: (y) => Number.isFinite(y),
                    tool: (tool) => ["brush", "eraser"].includes(tool),
                    colour: (colour) => true, // FIXME: We're not validating colours at the moment.
                    radius: (radius) => Number.isFinite(radius) && radius >= 0,
                }, state);
            };

            let valid_data = false;
            switch (data.shape) {
                case "circle":
                    valid_data = validate_data({
                        at: validate_pen_state,
                    });
                    break;
                case "bridge":
                    valid_data = validate_data({
                        from: validate_pen_state,
                        to: validate_pen_state,
                    });
                    break;
                case "clear":
                    valid_data = validate_data({});
                    break;
            }

            if (valid_data) {
                switch (data.shape) {
                    case "circle":
                        canvas.draw.colour = data.at.colour;
                        canvas.draw.circle(data.at.x, data.at.y, data.at.radius);
                        return;

                    case "bridge":
                        if (data.from.tool === data.to.tool) {
                            // If the tool is constant across a stroke, then we smoothly
                            // interpolate both the size and colour of the stroke, so even
                            // if the user moves the pointer quickly, it should still
                            // result in a smooth line. We *don't* yet interpolate the lines,
                            // so the result does occasionally appear piecewise-linear, but
                            // it looks fine.
                            canvas.draw.colour = canvas.draw.gradient(
                                data.from.x, data.from.y, data.from.colour,
                                data.to.x, data.to.y, data.to.colour,
                            );
                            canvas.draw.circle(data.from.x, data.from.y, data.from.radius);
                            canvas.draw.circle(data.to.x, data.to.y, data.to.radius);
                            canvas.draw.connect_circles(
                                data.from.x, data.from.y, data.from.radius,
                                data.to.x, data.to.y, data.to.radius,
                            );
                        } else {
                            // If the tool changes mid-stroke, we treat it as a new
                            // stroke and do not interpolate.
                            canvas.draw.colour = data.to.colour;
                            canvas.draw.circle(data.to.x, data.to.y, data.to.radius);
                        }
                        return;

                    case "clear":
                        canvas.clear();
                        return;
                }
            } else {
                console.error(`Received bad drawing data from ${from_server ? "the server": "itself"}:`, data);
            }
        }
    });
    // For now, we're going to fetch the host and port for the WebSocket server from the query string.
    const query_pairs = new Map(window.location.search.slice(1).split("&").map((pair) => pair.split("=")));
    const host = query_pairs.get("host");
    const port = query_pairs.get("port");
    if (host !== undefined && port !== undefined) {
        client.connect(decodeURIComponent(host), decodeURIComponent(port));
    } else {
        console.log("The host and port must be present in the URL query string to connect to the server.");
    }

    const pen = new Pen();

    const MIN_STROKE_RADIUS = 5;
    const MAX_STROKE_RADIUS = 40;
    const MAIN_TOOL = "brush";
    const ALT_TOOL = "eraser";
    const SCROLL_DAMPENING = 40;

    let stroke_radius = 10;

    tools = {
        red: new Tool("Red", { hue: 0 }),
        green: new Tool("Green", { hue: 110 }),
        blue: new Tool("Blue", { hue: 230 }),
        eraser: new Tool("Eraser", {}),
    };

    const update_state_for_tool = (state, tool) => {
        if (state === null) {
            return;
        }

        switch (tool) {
            case "brush":
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
                state.stroke_radius = stroke_radius;
                break;
            case "eraser":
                state.colour = "white";
                state.stroke_radius = stroke_radius * 4;
                break;
        }
        state.tool = tool;
    };

    const pen_state_from_event = (event) => {
        const state = PenState.from_event(event, canvas.element);
        if (tools.eraser.active) {
            update_state_for_tool(state, "eraser");
        } else {
            update_state_for_tool(state, "brush");

        }
        return state;
    };

    const pointer_down = (event, original_event = event) => {
        pen.state = pen_state_from_event(event);
        if (event.buttons & SECONDARY_PEN_BUTTON || event.shiftKey) {
            update_state_for_tool(pen.state, ALT_TOOL);
        }

        if (event.button === 0) {
            // This is a hack to get around the fact you can't call `preventDefault` on
            // non-native JavaScript objects.
            original_event.preventDefault();
            pen.held = true;
            client.send_message({
                kind: "draw",
                shape: "circle",
                at: pen.state.as_message(),
            });
        }
    };

    const draw_brush = (stroke_radius) => {
        brush_layer.clear();
        if (pen.state !== null) {
            brush_layer.draw.circle(pen.state.x, pen.state.y, 0.5 * stroke_radius, false);
            if (pen.state.pointerType !== "mouse") {
                // We'll draw a dashed circle of the maximum possible
                // stroke size for pointers that have variable pressure.
                brush_layer.context.setLineDash([4, 4]);
                brush_layer.draw.circle(pen.state.x, pen.state.y, stroke_radius, false);
                brush_layer.context.setLineDash([]);
            }
        }
    }

    const pointer_move = (event) => {
        event.preventDefault();

        const now = pen_state_from_event(event);
        if (event.buttons & SECONDARY_PEN_BUTTON || event.shiftKey) {
            // Unfortunately, for some pens, `events.buttons` is only updated when the
            // pen is held down, not when hovering, so we can't update the cursor in
            // this case.
            update_state_for_tool(now, ALT_TOOL);
        }

        if (pen.held && pen.changed(now)) {
            client.send_message({
                kind: "draw",
                shape: "bridge",
                from: pen.state.as_message(),
                to: now.as_message(),
            });
        }

        pen.state = now;

        draw_brush(pen.state.stroke_radius);
    };

    const pointer_up = (event) => {
        if (event.button === -1 || event.button === 0) {
            event.preventDefault();
            pen.held = false;
        }
    };

    // Events for stylus events while holding the primary button on a stylus.
    // For some reason, these trigger as mouse events instead of pointer events.
    // Note: these are *not* actual mouse events, which will go through the pointer
    // events.
    canvas.element.addEventListener("mousedown", (event) => {
        // For some reason, the `mousedown` event doesn't properly
        // capture `event.buttons` consistently with `pointermove`,
        // so we have to override `event` here. This is also
        // useful for overriding `pressure` and `pointerType`.
        const overridden_event = {};
        // We can't use `Object.assign` here, because the properties
        // aren't enumerable.
        for (const key in event) {
            overridden_event[key] = event[key];
        }
        return pointer_down(Object.assign(overridden_event, {
            buttons: SECONDARY_PEN_BUTTON,
            pressure: 0.5,
            pointerType: "pen",
        }), event);
    });
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

    // The shift key is used to toggle the alt tool (if the user's not using the
    // stylus buttons).
    document.addEventListener("keydown", (event) => {
        if (event.key === "Shift" && pen.state !== null) {
            event.preventDefault();
            update_state_for_tool(pen.state, ALT_TOOL);
            draw_brush(pen.state.stroke_radius);
        }
    });
    document.addEventListener("keyup", (event) => {
        if (event.key === "Shift" && pen.state !== null && !tools.eraser.active) {
            event.preventDefault();
            update_state_for_tool(pen.state, MAIN_TOOL);
            draw_brush(pen.state.stroke_radius);
        }
    });

    // Tool panel.
    const tool_panel = document.createElement("ul");
    for (const tool of Object.values(tools)) {
        tool_panel.appendChild(tool.element);
    }
    document.body.appendChild(tool_panel);

    // Action panel.
    const action_panel = document.createElement("ul");
    action_panel.appendChild(new Action("Clear", () => {
        if (window.confirm("Are you sure you want to clear the canvas?")) {
            canvas.clear();
            client.send_message({
                kind: "draw",
                shape: "clear",
            });
        }
    }).element);
    document.body.appendChild(action_panel);

    const update_stroke_radius = (value) => {
        stroke_radius = value;
        let scale = 1;
        if (pen.state !== null && pen.state.tool === "eraser") {
            scale = 4;
        }
        draw_brush(stroke_radius * scale);
    };

    // We display a range to allow the user to change the range of stroke sizes.
    const stroke_range = document.createElement("input");
    stroke_range.type = "range";
    stroke_range.min = MIN_STROKE_RADIUS;
    stroke_range.max = MAX_STROKE_RADIUS;
    stroke_range.value = stroke_radius;
    stroke_range.addEventListener("input", () => update_stroke_radius(parseInt(stroke_range.value)));
    const range_wrapper = document.createElement("div");
    range_wrapper.classList.add("range_wrapper");
    range_wrapper.appendChild(stroke_range);
    document.body.appendChild(stroke_range);

    // The user can also change the range of stroke sizes by scrolling (or using
    // the secondary button and dragging using a stylus).
    window.addEventListener("wheel", (event) => {
        event.preventDefault();
        stroke_range.value = Math.round(stroke_radius - event.wheelDeltaY / SCROLL_DAMPENING);
        update_stroke_radius(parseInt(stroke_range.value));
    });
});
