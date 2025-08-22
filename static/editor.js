/**
 * 
 * editor.js
 * 
 * Contains the client-side code for the text editor
 * 
*/

'use strict';

function assert(value, text = 'Assertion failed') {
  if (!value) {
    console.error(text);
    // alert(text);
    // debugger;
  }
}

/** @typedef { { position: number, username: string, colour: string } } Cursor */
/** @typedef { { flags: false, ranges: [number, number][] } | {flags: true, ranges: Map<String, [number, number][]> } } PropertyRanges */

// Editor class sets up the client-side functionality of the text editor
export class Editor {
  static #CURSOR_COLOURS = ['red', 'orange', 'brown', 'green', 'blue', 'violet', 'pink'];

  /** @type { Record<number, Cursor> } */
  #cursors = {};
  /** @type { Record<number, Cursor> } */
  #server_cursors = {};

  /** @type { (
   *  { type: 'remove', start: number, end: number } |
   *  { type: 'add', position: number, text: string } |
   *  { type: 'add_property', start: number, end: number, property: string, flag: string? } |
   *  { type: 'remove_property', start: number, end: number, property: string } |
   *  { type: 'cursor', position: number }
   * )[] } */
  #builtup_inputs = []; // This is a queue
  #server_content = '';
  #content = '';
  /** @type { Map<string, PropertyRanges> } */
  #properties = new Map()
  /** @type { Map<string, PropertyRanges> } */
  #server_properties = new Map()

  // last_mod_id is also used to check whether the file has been loaded
  #last_mod_id = null;
  #last_mod_id_dirty = false;

  #socket;
  /** @type {number} */
  #userid = undefined;
  #read_only;

  constructor(
  /** @type {boolean} */ read_only,
  ) {
    this.#read_only = read_only;

    // @ts-ignore
    this.#socket = io('/text');

    this.#socket.io.on('ping', this.#on_ping.bind(this));
    this.#socket.on('connected', this.#on_connected.bind(this));
    this.#socket.on('user_disconnected', this.#on_user_disconnected.bind(this));
    this.#socket.on('add_region', this.#on_add_region.bind(this));
    this.#socket.on('remove_region', this.#on_remove_region.bind(this));
    this.#socket.on('add_property', this.#on_add_property.bind(this));
    this.#socket.on('remove_property', this.#on_remove_property.bind(this));
    this.#socket.on('cursor_moved', this.#on_cursor_moved.bind(this));
  }

  get content() {
    return this.#content;
  }

  get position() {
    if (this.#read_only) return 0;
    return this.#cursors[this.#userid].position
  }

  // Sets up the user's text editor when they connect, such as adding content, cursors and IDs, and making the css of the text editor go from grey to white to indicate it has loaded
  #on_connected(
  /** @type {number} */ my_userid,
  /** @type {string} */ content,
  /** @type {number} */ last_mod_id,
  ) {
    this.#userid = my_userid
    this.#content = content
    this.#server_content = content
    this.#last_mod_id = last_mod_id

    if (!this.#read_only) {
      this.#cursors[this.#userid] = { position: 0, username: 'Me', colour: 'black' };
      this.#server_cursors = structuredClone(this.#cursors);
    }

    document.getElementById('shared-textbox').classList.remove('shared-textbox-loading')
    document.getElementById('shared-textbox').classList.add('shared-textbox-initialized')

    this.#render();
  }

  // When a user disconnects, delete the cursor dictionaries 
  #on_user_disconnected(
  /** @type {number} */ userid,
  ) {
    delete this.#server_cursors[userid];
    delete this.#cursors[userid];
  }

  // Manages a ping event by updating the last modification ID, pings are sent by the server to see if the client is still connected
  #on_ping() {
    if (this.#last_mod_id_dirty) {
      this.#socket.emit('update_last_mod_id', this.#last_mod_id)
      this.#last_mod_id_dirty = false;
    }
  }

  // Handles the movement of any user's cursor
  #on_cursor_moved(
    /** @type {number} */ position,
    /** @type {number} */ userid,
    /** @type {string} */ username,
    /** @type {number} */ mod_id,
  ) {
    this.#set_last_mod_id(mod_id);

    if (userid === this.#userid) {
      const expect = this.#builtup_inputs.shift();
      assert(expect.type === 'cursor' && expect.position === position);
      this.#server_cursors[userid].position = position;
      return;
    };

    for (const input of this.#builtup_inputs) {
      switch (input.type) {
        case 'remove':
          if (position > input.start) {
            position -= Math.min(input.end, position) - input.start;
          }
          break;
        case 'add':
          if (position > input.position) {
            position += input.text.length;
          }
          break;
      }
    }

    if (this.#cursors[userid]) {
      this.#cursors[userid].position = position;
    } else {
      const remaining_colours = Editor.#CURSOR_COLOURS.filter(col => !Object.values(this.#cursors).find((cur) => cur.colour == col));

      this.#cursors[userid] = {
        position,
        username,
        colour: remaining_colours[Math.floor(Math.random() * remaining_colours.length)],
      };
    }

    this.#server_cursors[userid] = structuredClone(this.#cursors[userid]);
    this.#render()
  }

  // Handles when any user removes a block of text from the text editor
  #on_remove_region(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {number} */ userid,
    /** @type {number} */ mod_id,
  ) {
    this.#set_last_mod_id(mod_id);

    this.#actual_remove(start, end, true);

    if (userid === this.#userid) {
      const expect = this.#builtup_inputs.shift();
      assert(expect.type === 'remove' && expect.start === start && expect.end === end);
    } else {
      this.#content = this.#server_content;
      this.#cursors = structuredClone(this.#server_cursors);
      this.#properties = structuredClone(this.#server_properties);

      for (const input of this.#builtup_inputs) {
        switch (input.type) {
          case 'remove':
            if (start < input.start) input.start -= Math.min(input.start, end) - start;
            if (start < input.end) input.end -= Math.min(input.end, end) - start;

            this.#actual_remove(input.start, input.end);
            break;

          case 'add':
            if (start < input.position) input.position -= Math.min(input.position, end) - start;

            this.#actual_add(input.text, input.position);
            break;

          case 'remove_property':
            if (start < input.start) input.start -= Math.min(input.start, end) - start;
            if (start < input.end) input.end -= Math.min(input.end, end) - start;

            this.#actual_remove_property(input.start, input.end, input.property);
            break;

          case 'add_property':
            if (start < input.start) input.start -= Math.min(input.start, end) - start;
            if (start < input.end) input.end -= Math.min(input.end, end) - start;

            this.#actual_add_property(input.start, input.end, input.property, input.flag);
            break;

          case 'cursor':
            if (start < input.position) {
              input.position -= Math.min(input.position, end) - start;
            }

            this.#cursors[this.#userid].position = input.position;
            break;
        }
      }

      this.#render();
    }
  }

  // Handles when any user adds a block of text at a certain position
  #on_add_region(
    /** @type {string} */ text,
    /** @type {number} */ position,
    /** @type {number} */ userid,
    /** @type {number} */ mod_id,
  ) {
    this.#set_last_mod_id(mod_id);

    this.#actual_add(text, position, true);

    if (userid === this.#userid) {
      const expect = this.#builtup_inputs.shift();
      assert(expect.type === 'add' && expect.text === text && expect.position === position);
    } else {
      this.#content = this.#server_content;
      this.#cursors = structuredClone(this.#server_cursors);
      this.#properties = structuredClone(this.#server_properties);

      for (const input of this.#builtup_inputs) {
        switch (input.type) {
          case 'remove':
            if (position < input.start) input.start += text.length;
            if (position <= input.end) input.end += text.length;

            this.#actual_remove(input.start, input.end);
            break;

          case 'add':
            if (position < input.position) input.position += text.length;

            this.#actual_add(input.text, input.position);
            break;

          case 'remove_property':
            if (position < input.start) input.start += text.length;
            if (position <= input.end) input.end += text.length;

            this.#actual_remove_property(input.start, input.end, input.property);
            break;

          case 'add_property':
            if (position < input.start) input.start += text.length;
            if (position <= input.end) input.end += text.length;

            this.#actual_add_property(input.start, input.end, input.property, input.flag);
            break;

          case 'cursor':
            if (position < input.position) input.position += text.length;

            this.#cursors[this.#userid].position = input.position;
            break;
        }
      }

      this.#render();
    }
  }

  // Handles any user's removal of a property from a block of text on the text editor 
  #on_remove_property(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {string} */ property,
    /** @type {number} */ userid,
    /** @type {number} */ mod_id,
  ) {
    this.#set_last_mod_id(mod_id);

    this.#actual_remove_property(start, end, property, true);

    if (userid === this.#userid) {
      const expect = this.#builtup_inputs.shift();
      assert(expect.type === 'remove_property' && expect.start === start && expect.end === end && expect.property === property);
    } else {
      this.#properties = structuredClone(this.#server_properties);

      for (const input of this.#builtup_inputs) {
        switch (input.type) {
          case 'remove':
            if (start > input.start) start -= Math.min(input.end, start) - input.start;
            if (end > input.start) end -= Math.min(input.end, end) - input.start;
            break;

          case 'add':
            if (start > input.position) start += input.text.length;
            if (end > input.position) end += input.text.length;
            break;

          case 'remove_property':
            this.#actual_remove_property(input.start, input.end, input.property);
            break;

          case 'add_property':
            this.#actual_add_property(input.start, input.end, input.property, input.flag);
            break;
        }
      }
    }

    this.#render()
  }

  // Handles any user's addition of a property to a block of text on the text editor 
  #on_add_property(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {string} */ property,
    /** @type {string} */ flag,
    /** @type {number} */ userid,
    /** @type {number} */ mod_id,
  ) {
    this.#set_last_mod_id(mod_id);

    this.#actual_add_property(start, end, property, flag, true);

    if (userid === this.#userid) {
      const expect = this.#builtup_inputs.shift();
      assert(expect.type === 'add_property' && expect.start === start && expect.end === end && expect.property === property && expect.flag == flag);
    } else {
      this.#properties = structuredClone(this.#server_properties);

      for (const input of this.#builtup_inputs) {
        switch (input.type) {
          case 'remove':
            if (start > input.start) start -= Math.min(input.end, start) - input.start;
            if (end > input.start) end -= Math.min(input.end, end) - input.start;
            break;

          case 'add':
            if (start > input.position) start += input.text.length;
            if (end > input.position) end += input.text.length;
            break;

          case 'remove_property':
            this.#actual_remove_property(input.start, input.end, input.property);
            break;

          case 'add_property':
            this.#actual_add_property(input.start, input.end, input.property, input.flag);
            break;
        }
      }
    }

    this.#render()
  }

  // Applies a shift function to all property ranges and cursor positions
  #shift_all_fixed_points(
    /** @type { function(number): number } */ shift,
    /** @type { boolean } */ server_side,
  ) {
    Object.values(server_side ? this.#server_cursors : this.#cursors).forEach((cursor) => cursor.position = shift(cursor.position));
    (server_side ? this.#server_properties : this.#properties).forEach((prop) => {
      if (prop.flags === true)
        prop.ranges.forEach((ranges) => ranges.forEach(range => (range[0] = shift(range[0]), range[1] = shift(range[1]))));
      else
        prop.ranges.forEach((range) => (range[0] = shift(range[0]), range[1] = shift(range[1])))
    });
  }

  // Removes empty property ranges to prevent potential issues  
  #remove_empty_property_ranges(
    /** @type { boolean } */ server_side,
  ) {
    function remove_empty(/** @type { [number, number][] } */ ranges) {
      const to_remove = [];

      for (let i = 0; i < ranges.length; i++) {
        if (ranges[i][0] >= ranges[i][1])
          to_remove.push(i);
      }

      while (to_remove.length > 0) {
        ranges.splice(to_remove.pop(), 1);
      }
    }

    const _properties = server_side ? this.#server_properties : this.#properties;

    _properties.forEach((prop, name) => {
      if (prop.flags === true) {
        prop.ranges.forEach((ranges, key) => {
          remove_empty(ranges);
          if (ranges.length === 0)
            prop.ranges.delete(key);
        })
        if (prop.ranges.size === 0)
          _properties.delete(name);

      } else {
        remove_empty(prop.ranges);
        if (prop.ranges.length === 0)
          _properties.delete(name);
      }
    });
  }

  // This method focuses on actually removing text based on indexes rather than deciding what to remove 
  #actual_remove(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {boolean} */ server_side = false,
  ) {
    this.#shift_all_fixed_points(pos => pos > start ? pos - (Math.min(end, pos) - start) : pos, server_side)
    this.#remove_empty_property_ranges(server_side);

    if (server_side) {
      this.#server_content = this.#server_content.substring(0, start) + this.#server_content.substring(end);
    } else {
      this.#content = this.#content.substring(0, start) + this.#content.substring(end);
    }
  }

  // This method focuses on actually adding text based on indexes rather than deciding where to add it
  #actual_add(
    /** @type {string} */ text,
    /** @type {number} */ position,
    /** @type {boolean} */ server_side = false,
  ) {
    this.#shift_all_fixed_points((pos) => pos > position ? pos + text.length : pos, server_side)

    if (server_side) {
      this.#server_content = this.#server_content.substring(0, position) + text + this.#server_content.substring(position);
    } else {
      this.#content = this.#content.substring(0, position) + text + this.#content.substring(position);
    }
  }

  // Properties actually get set to the appropriate block of text in this method
  #actual_add_property(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {string} */ property,
    /** @type {string} */ flag,
    /** @type {boolean} */ server_side = false,
  ) {
    const _properties = server_side ? this.#server_properties : this.#properties;

    const prop = _properties.get(property);
    if (prop) {
      this.#actual_remove_property(start, end, property, server_side);

      /** @type { [number, number][] } */
      let ranges;

      if (prop.flags === true) {
        if (!prop.ranges.has(flag))
          prop.ranges.set(flag, []);

        ranges = prop.ranges.get(flag);
      } else {
        ranges = prop.ranges;
      }

      let was_added = false;
      ranges.forEach((range) => {
        if (range[1] == start) {
          range[1] = end;
          was_added = true
        } else if (range[0] == end) {
          range[1] = start;
          was_added = true
        }
      });

      if (!was_added)
        ranges.push([start, end]);
    } else {
      if (flag)
        _properties.set(property, { flags: true, ranges: new Map([[flag, [[start, end]]]]) });
      else
        _properties.set(property, { flags: false, ranges: [[start, end]] });
    }
  }

  // Properties are actually removed from the appropriate block of text in this method
  #actual_remove_property(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {string} */ property,
    /** @type {boolean} */ server_side = false,
  ) {
    const _properties = server_side ? this.#server_properties : this.#properties;

    const prop = _properties.get(property);
    if (prop) {
      function cutOverlaps(/** @type { [number, number][] } */ ranges) {
        const new_ranges = [];
        ranges.forEach((range) => {
          if (range[0] >= start) {
            if (range[1] > end)
              new_ranges.push([Math.max(end, range[0]), range[1]]);
          } else {
            if (range[1] > end)
              new_ranges.push([range[0], start], [end, range[1]]);
            else
              new_ranges.push([range[0], Math.min(start, range[1])]);
          }
        });
        return new_ranges;
      }

      if (prop.flags === true) {
        prop.ranges.forEach((ranges, key) => {
          const new_ranges = cutOverlaps(ranges);

          if (new_ranges.length > 0)
            prop.ranges.set(key, new_ranges);
          else
            prop.ranges.delete(key);
        })
        if (prop.ranges.size == 0)
          _properties.delete(property);

      } else {
        const new_ranges = cutOverlaps(prop.ranges);

        if (new_ranges.length > 0)
          prop.ranges = new_ranges;
        else
          _properties.delete(property);
      }
    }
  }


  // Deals with user removing a block of text by performing necessary checks and actions before calling the function which actually removes the text
  remove(
    /** @type {number} */ start,
    /** @type {number} */ end
  ) {
    if (this.#read_only) return;

    assert(start >= 0 && start <= this.#content.length)
    assert(end >= 0 && end <= this.#content.length)

    this.#builtup_inputs.push({
      start, end,
      type: 'remove',
    });

    this.#socket.emit('remove_region', start, end, this.#last_mod_id);
    this.#last_mod_id_dirty = false;
    this.#actual_remove(start, end);
    this.#render();
  }

  // Deals with user adding a block of text by performing necessary checks and actions for addition of text before calling the function which actually adds the text
  add(
    /** @type {string} */ text,
    /** @type {number} */ position
  ) {
    if (this.#read_only) return;

    assert(position >= 0 && position <= this.#content.length)

    this.#builtup_inputs.push({
      position, text,
      type: 'add',
    });

    this.#socket.emit('add_region', text, position, this.#last_mod_id);
    this.#last_mod_id_dirty = false;
    this.#actual_add(text, position);

    if (this.position === position) {
      this.move_cursor(position + text.length);
    } else {
      this.#render();
    }
  }

  // Deals with user moving their cursor. Performs necessary checks, adds the modification made and emits event to the server before rendering it 
  move_cursor(
    /** @type {number} */ position
  ) {
    if (this.#read_only) return;

    assert(position >= 0 && position <= this.#content.length)

    this.#builtup_inputs.push({
      position,
      type: 'cursor',
    });

    this.#cursors[this.#userid].position = position;
    this.#socket.emit('cursor_moved', position, this.#last_mod_id);
    this.#last_mod_id_dirty = false;
    this.#render();
  }

  // Deals with user toggling a property that can be toggled such as bold, so it removes a property to areas where it has already been applied and vice versa
  toggle_property(
    /** @type {number} */ start,
    /** @type {number} */ end,
    /** @type {string} */ property,
    /** @type {string} */ flag = undefined,
  ) {
    if (this.#read_only) return;

    assert(start >= 0 && start <= this.#content.length)
    assert(end >= 0 && end <= this.#content.length)

    /** @type { 'add' | 'remove' } */
    let action;
    if (this.#properties.has(property)) {
      const prop = this.#properties.get(property);

      /** @type { [number, number][] } */
      let ranges;
      if (prop.flags === true) {
        assert(flag !== undefined);
        ranges = prop.ranges.get(flag) ?? [];
      } else {
        assert(flag === undefined);
        ranges = prop.ranges;
      }

      const overlapping_ranges = ranges.filter((range) => start <= range[0] ? range[0] <= end : range[1] >= start);
      if (overlapping_ranges.length === 1 && overlapping_ranges[0][0] <= start && overlapping_ranges[0][1] >= end) {
        action = 'remove';
      } else {
        action = 'add';
      }
    } else {
      action = 'add';
    }

    switch (action) {
      case 'add':
        this.#builtup_inputs.push({
          type: 'add_property',
          start, end, property, flag
        });
        this.#socket.emit('add_property', start, end, property, flag, this.#last_mod_id);
        this.#actual_add_property(start, end, property, flag);
        break;
      case 'remove':
        this.#builtup_inputs.push({
          type: 'remove_property',
          start, end, property
        });
        this.#socket.emit('remove_property', start, end, property, this.#last_mod_id);
        this.#actual_remove_property(start, end, property);
        break;
    }
    this.#last_mod_id_dirty = false;

    this.#render()
  }

  // Getter returns the private boolean that determines permission
  is_read_only() {
    return this.#read_only;
  }

  // Checks whether private attribute userid is defined, which determines initialization 
  is_initialized() {
    return this.#userid !== undefined;
  }

  // Sets id of the last modification the user made
  #set_last_mod_id(/** @type {number} */ last_mod_id) {
    this.#last_mod_id = last_mod_id
    this.#last_mod_id_dirty = true;
  }

  // Creates the html for cursors and properties of text and displays it in the text editor
  #render() {
    const positions = Object.entries(this.#cursors);
    const properties = [...this.#properties.entries()];

    /** @type { [string, string?][] } */
    let active_properties = []; // Stack that holds the properties that are active at the current position

    let newHTML = '';
    for (let i = 0; i <= this.content.length; i++) {
      positions.forEach(([userid, cursor]) => {
        if (cursor.position == i)
          newHTML += `<span
              title="${cursor.username}"
              style="
                background-color: ${cursor.colour};
                border-color: ${cursor.colour};
                ${+userid === this.#userid ? 'animation: cursor-blink 1.5s steps(2, jump-none) infinite;' : ''}
              "
              class="cursor"
            ></span>`;
      });

      properties.forEach(([prop, range]) => {
        const addProperty = (
          /** @type { [number, number] } */[start, stop],
          /** @type { string } */ flag = undefined,
        ) => {
          if (start === i) {
            newHTML += `<${prop}${flag ? ' ' + flag : ''}>`
            active_properties.push([prop, flag]);
          } else if (stop === i) {
            const popped = []; // Stack that holds the properties need to be added back

            while (active_properties.length > 0) {
              const [name, flag] = active_properties.pop();
              if (name === prop) {
                break;
              }
              newHTML += `</${name}>`
              popped.push([name, flag]);
            }

            newHTML += `</${prop}>`

            while (popped.length > 0) {
              const [name, flag] = popped.pop();
              newHTML += `<${name}${flag ? ' ' + flag : ''}>`
              active_properties.push([name, flag]);
            }
          }
        };

        if (range.flags === true)
          range.ranges.forEach((ranges, flag) =>
            ranges.forEach((range) => addProperty(range, flag))
          );
        else
          range.ranges.forEach((range) => addProperty(range));
      });

      if (i != this.content.length) {
        const c = this.content[i];
        switch (c) {
          case '<':
            newHTML += '&lt;'
            break;
          case '>':
            newHTML += '&gt;'
            break;
          default:
            newHTML += c;
        }
      }
    }

    document.querySelector('#shared-textbox').innerHTML = newHTML;
  }
  
  // Makes a single iterative step in the specified direction (forwards or backwards) with consideration to a given start point
  step(
    /** @type {'backwards' | 'forwards'} */ direction,
    /** @type { number } */ start,
  ) {
    const end = direction === 'forwards' ? this.#content.length : 0;
    if (start == end) {
      return start;
    } else {
      return start + (direction === 'forwards' ? 1 : -1);
    }
  }

  // Takes in a regex expression as a condition, and steps through all of the text in the editor until it reaches the end or the condition has no longer been met
  step_while(
    /** @type { RegExp } */ condition,
    /** @type {'backwards' | 'forwards'} */ direction,
    /** @type { number } */ start = this.position,
  ) {
    let pos = start;
    if (direction === 'backwards' && pos > 0) pos--;

    const step = direction === 'forwards' ? 1 : -1;
    const end = direction === 'forwards' ? this.#content.length : 0;

    while (pos != end && this.#content[pos].match(condition)) {
      pos += step;
    }

    if (direction === 'backwards' && pos != end) pos++;

    return pos;
  }

  // Uses regex and step_while to find where the cursor should be placed when you press the up and down keys to go up and down by a line
  jump_line(
    /** @type {'backwards' | 'forwards'} */ direction,
    /** @type { number } */ start = this.position,
  ) {
    return this.step_while(/[^\n]/, direction, this.step(direction, start));
  }

  // Uses regex and step_while to skip to the next or previous word (used in ctrl+left and ctrl+right)
  jump_position(
    /** @type {'backwards' | 'forwards'} */ direction,
    /** @type { number } */ start = this.position,
  ) {
    // Skip all whitespace
    const pos = this.step_while(/\s/, direction, start);

    // Skip all non whitespace
    return this.step_while(/\S/, direction, pos);
  }

  // Shows each user's cursor's color
  getUsersHTML() {
    let users = '';
    for (const cursor of Object.values(this.#cursors)) {
      users += `<p style="color: ${cursor.colour};">${cursor.username}</p>`
    }
    return users;
  }
};
