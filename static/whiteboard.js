/**
 * 
 * whiteboard.js
 * 
 * Contains the client-side code for the whiteboard
 * 
*/

import { lineIntersectsRectangle, linesIntersect, pointInsideRectangle } from "./html_utilities.js";

// Editor class sets up the client-side functionality of the whiteboard
class Whiteboard {
    /** @type {(
     *  { type: 'selector', selected: SVGElement[], last_pos: [number, number] } |
     *  { type: 'pen', path: SVGPathElement? } |
     *  { type: 'eraser', last_pos: [number, number]? } |
     *  { type: 'shape', angles: number, path: SVGPathElement?, start_pos: [number, number]? }
     * )? } */
    #tool = undefined;
    #last_id = 0;
    #userid = Math.random();
    // @ts-ignore
    #socket = io('/whiteboard');
    /** @type { HTMLElement } */
    #area = document.querySelector('#drawing-area');
    /** @type { boolean } */
    #read_only;

    // Huge constructor binds all of the events to functions, and manages client side events done by the user
    constructor(/** @type { boolean } */read_only) {
        this.#read_only = read_only;

        this.#socket.on('draw', this.#on_draw.bind(this));
        this.#socket.on('remove', this.#on_remove.bind(this));
        this.#socket.on('edit', this.#on_edit.bind(this));

        this.#socket.on('group', this.#group.bind(this));
        this.#socket.on('ungroup', this.#ungroup.bind(this));

        this.change_tool('selector');

        document.querySelector('#select-selector').addEventListener('click', () => this.change_tool('selector'));
        document.querySelector('#select-pen').addEventListener('click', () => this.change_tool('pen'));
        document.querySelector('#select-eraser').addEventListener('click', () => this.change_tool('eraser'));
        // @ts-ignore
        document.querySelector('#select-shape').addEventListener('click', () => this.change_tool('shape', Math.max(+document.getElementById('specify-sides').value,3)));
        
        document.getElementById('specify-sides').addEventListener('change', (e) => {
            if (this.#tool.type == 'shape') {
                // @ts-ignore
               this.#tool.angles = Math.max(+e.target.value, 3);
            }
          });

        document.querySelector('#group').addEventListener('click', () => {
            if (this.#read_only) return;

            if (this.#tool.type == 'selector') {
                if (this.#tool.selected.length > 1) {
                    const child_ids = this.#tool.selected.map(ele => {
                        ele.style.stroke = null;
                        return ele.id;
                    });

                    const g = this.#group(this.#new_id(), child_ids);
                    this.#socket.emit('group', g.id, child_ids);

                    g.style.stroke = 'cyan';
                    this.#tool.selected = [g];
                } else if (this.#tool.selected.length === 1 && this.#tool.selected[0].tagName == 'g') {
                    const group = this.#tool.selected[0];
                    group.style.stroke = null;

                    const selected = [];
                    group.childNodes.forEach((/** @type {HTMLElement} */ ele) => {
                        ele.style.stroke = 'cyan';
                        selected.push(ele);
                    });

                    this.#ungroup(group.id);

                    this.#tool.selected = selected;
                    this.#socket.emit('ungroup', group.id);
                }
            }
        });


        this.#area.addEventListener('mousedown', (e) => {
            if (this.#read_only) return;

            const [x, y] = this.#transformCoordinates(e.clientX, e.clientY);

            switch (this.#tool?.type) {
                case 'selector':
                    if (!e.shiftKey && !e.ctrlKey) {
                        this.#tool.selected.forEach((ele) => ele.style.stroke = null);
                        this.#tool.selected = [];
                        this.#tool.last_pos = undefined;
                    }

                    let ele = document.elementFromPoint(e.clientX, e.clientY);
                    if (ele != this.#area && this.#area.contains(ele)) {
                        while (ele.parentElement != this.#area) ele = ele.parentElement;

                        const path = /** @type { SVGPathElement } */ (ele);
                        if (path.style.stroke !== 'cyan') {
                            this.#tool.selected.push(path);
                            this.#tool.selected.at(-1).style.stroke = 'cyan';
                        }
                    }
                    if (this.#tool.selected.length > 0)
                        this.#tool.last_pos = [x, y];
                    break;
                case 'pen':
                    this.#tool.path = this.#create_path();
                    this.#tool.path.setAttribute('d', `M ${x} ${y}`);
                    this.#area.appendChild(this.#tool.path);
                    break;
                case 'eraser':
                    this.#tool.last_pos = [x, y];
                    break;
                case 'shape':
                    this.#tool.start_pos = [x, y];

                    this.#tool.path = this.#create_path();
                    this.#tool.path.setAttribute('d', this.#draw_poly(this.#tool.angles, x, y, x, y));
                    this.#area.appendChild(this.#tool.path);
                    break;
            }
        });

        document.addEventListener('mouseup', (e) => {
            if (this.#read_only) return;

            switch (this.#tool?.type) {
                case 'selector':
                    function recursive_move(/** @type {SVGElement} */ele) {
                        switch (ele.tagName) {
                            case 'g':
                                ele.childNodes.forEach(recursive_move.bind(this))
                                break;
                            case 'path':
                                this.#socket.emit('edit', ele.id, ele.getAttribute('d'));
                                break;
                        }
                    }
                    this.#tool.selected.forEach(recursive_move.bind(this));

                    this.#tool.last_pos = undefined;
                    break
                case 'pen':
                    if (this.#tool.path) {
                        this.#tool.path.id = this.#new_id();
                        this.#socket.emit('draw', this.#tool.path.id, this.#tool.path.getAttribute('d'))
                    }

                    this.#tool.path = undefined;
                    break;
                case 'eraser':
                    this.#tool.last_pos = undefined;
                    break;
                case 'shape':
                    if (this.#tool.path) {
                        this.#tool.path.id = this.#new_id();
                        this.#socket.emit('draw', this.#tool.path.id, this.#tool.path.getAttribute('d'))
                    }

                    this.#tool.start_pos = undefined;
                    this.#tool.path = undefined;
                    break;
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (this.#read_only) return;

            const [x, y] = this.#transformCoordinates(e.clientX, e.clientY);

            switch (this.#tool?.type) {
                case 'selector':
                    if (this.#tool.last_pos) {
                        const [lx, ly] = this.#tool.last_pos;

                        function recursive_move(/** @type {SVGElement} */ele) {
                            switch (ele.tagName) {
                                case 'g':
                                    ele.childNodes.forEach(recursive_move.bind(this))
                                    break;
                                case 'path':
                                    const d = ele.getAttribute('d');
                                    const new_d = 'M ' + d.substring(2).split(' L ').map(point => {
                                        let [px, py] = point.split(' ').map(Number.parseFloat);
                                        px += x - lx;
                                        py += y - ly;
                                        return `${px} ${py}`;
                                    }).join(' L ');
                                    ele.setAttribute('d', new_d);
                                    break;
                            }
                        }

                        this.#tool.selected.forEach(recursive_move.bind(this));
                        this.#tool.last_pos = [x, y];
                    }
                    break;
                case 'pen':
                    if (this.#tool.path) {
                        const d = this.#tool.path.getAttribute('d');
                        this.#tool.path.setAttribute('d', d + ` L ${x} ${y}`);
                    }
                    break;
                case 'eraser':
                    if (this.#tool.last_pos) {
                        const last_pos = this.#tool.last_pos;

                        function recursive_remove(/** @type {Element} */ ele) {
                            const rect = ele.getBoundingClientRect();
                            const top_left = this.#transformCoordinates(rect.left, rect.top);
                            const bottom_right = this.#transformCoordinates(rect.right, rect.bottom);

                            if (!pointInsideRectangle(last_pos, top_left, bottom_right) &&
                                !pointInsideRectangle([x, y], top_left, bottom_right) &&
                                !lineIntersectsRectangle([x, y], last_pos, top_left, bottom_right)) {
                                return false;
                            }

                            switch (ele.tagName) {
                                case 'g':
                                    for (let i = 0; i < ele.children.length; i++) {
                                        const child = ele.children.item(i)
                                        if (recursive_remove.bind(this)(child)) {
                                            return true;
                                        }
                                    }
                                    break;
                                case 'path':
                                    const points = ele.getAttribute('d').substring(2).split(' L ').map(
                                        /** @type { function(string):[number, number] } */
                                        (p => p.split(' ').map(Number.parseFloat))
                                    );

                                    for (let i = 0; i < points.length - 1; i++) {
                                        if (linesIntersect([x, y], last_pos, points[i], points[i + 1])) {
                                            return true;
                                        }
                                    }
                                    break;
                            }
                            return false;
                        }

                        const toDelete = [];
                        for (let i = 0; i < this.#area.children.length; i++) {
                            const child = this.#area.children.item(i)
                            if (recursive_remove.bind(this)(child)) {
                                toDelete.push(child);
                            }
                        }
                        toDelete.forEach(child => {
                            this.#area.removeChild(child);
                            this.#socket.emit('remove', child.id);
                        })

                        this.#tool.last_pos = [x, y];
                    }
                    break;
                case 'shape':
                    if (this.#tool.path) {
                        this.#tool.path.setAttribute('d', this.#draw_poly(this.#tool.angles, x, y, ...this.#tool.start_pos));
                    }

                    break;
            }
        });
    }

    // Deals with the user trying to change the tool that they are using in the tool bar
    change_tool(
        /** @type { string }*/ new_tool,
        /** @type { any }*/ argument,
    ) {
        if (this.#tool) {
            switch (this.#tool.type) {
                case 'selector':
                    this.#tool.selected.forEach((ele) => ele.style.stroke = null);
                    break;
            }

            document.getElementById(`select-${this.#tool.type}`).style.backgroundColor = null;
        }

        document.getElementById(`select-${new_tool}`).style.backgroundColor = 'white';
        
        document.getElementById('specify-sides').style.visibility = new_tool == 'shape' ? 'visible' : 'hidden';

        switch (new_tool) {
            case 'selector':
                this.#tool = { type: 'selector', selected: [], last_pos: undefined };
                break;
            case 'pen':
                this.#tool = { type: 'pen', path: undefined };
                break;
            case 'eraser':
                this.#tool = { type: 'eraser', last_pos: undefined };
                break;
            case 'shape':
                this.#tool = { type: 'shape', angles: argument, path: undefined, start_pos: undefined };
                break;
        }
    }

    // Method is called when the server tells the client about another user that has added an element, it adds the new element to the user's board
    #on_draw(
        /** @type { string } */ id,
        /** @type { string } */ path
    ) {
        if (document.getElementById(id)) return;

        const elem = this.#create_path();
        elem.id = id;
        elem.setAttribute('d', path);
        this.#area.appendChild(elem);
    }

    // Method is called when the server tells the client about another user that has erased an element with their eraser, it removes the element from the user's board
    #on_remove(
        /** @type { string } */ id,
    ) {
        document.getElementById(id)?.remove();
    }

    // Method is called when the server tells the client about another user that has edited a path
    #on_edit(
        /** @type { string } */ id,
        /** @type { string } */ new_path,
    ) {
        document.getElementById(id)?.setAttribute('d', new_path);
    }

    // Takes in the children id's to be merged, removes all of the children from the screen, and adds the children back to the screen as one group, returns the new group that was made
    #group(
        /** @type { string } */ group_id,
        /** @type { string[] } */ children_id,
    ) {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); 
        group.id = group_id;

        children_id.forEach(id => {
            const child = document.getElementById(id);
            if (child) {
                this.#area.removeChild(child);
                group.appendChild(child);
            }
        });
        this.#area.appendChild(group);
        return group;
    }

    // Takes a group_id and splits it into all of its children. Removes the group from the screen and adds all children back to the screen.
    #ungroup(
        /** @type { string } */ group_id,
    ) {
        const group = document.getElementById(group_id);
        while (group.children.length > 0) {
            const child = group.children.item(0)
            group.removeChild(child);
            this.#area.appendChild(child);
        }

        this.#area.removeChild(group);
        return group;
    }

    // Returns an ID with the next number up by one
    #new_id() {
        return 'draw-' + this.#userid + '-' + (this.#last_id++)
    }

    // Transforms a browser co-ordinate into a co-ordinate relative to the whiteboard's drawing area
    /** @returns { [number, number] } */
    #transformCoordinates(
        /** @type { number } */ x,
        /** @type { number } */ y
    ) {
        const rect = this.#area.getBoundingClientRect();
        return [x - rect.x, y - rect.y];
    }

    // Complex mathematical model used for drawing regular polygons with a varying number of vertices 
    #draw_poly(n, left, top, right, bottom) {
        const angle = 2 * Math.PI / n; // Calculates exterior angle in radians

        const h = top - bottom; // Height of the shape
        let a; // a is the length of a side of the polygon
        if (n % 2 == 0) {
            a = h * Math.tan(Math.PI / n) // If number of sides is even, height * tan(pi/number of sides) finds the side length
        } else {
            a = h * 1 / (1 / (2 * Math.sin(Math.PI / n)) + 1 / (2 * Math.tan(Math.PI / n))); // If number of sides is odd, uses this formula to find the side length
        }
        
        // Proceeds to create a line of length a, rotate by a constant angle, and repeat until its fully articulated, and ready to be returned and drawn
        let path = `M ${(left + right) / 2 - a / 2} ${bottom}`

        let last_point = [(left + right) / 2 - a / 2, bottom];
        let last_angle = -angle;
        for (let i = 0; i <= n; i++) {
            last_angle += angle;
            last_point[0] += a * Math.cos(last_angle);
            last_point[1] += a * Math.sin(last_angle);
            path += ` L ${last_point[0]} ${last_point[1]}`
        }

        return path;
    }


    // Used for creating a path, currently always 5px  
    #create_path() {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.style.stroke = undefined;
        path.style.fill = 'none';
        path.style.strokeWidth = '5px';
        return path;
    }

}

// Used to instantiate a Whiteboard object and initialize the whiteboard
export function init(read_only) {
    const editor = new Whiteboard(read_only);
    window['editor'] = editor;
}