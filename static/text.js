/** 
 * 
 * text.js
 * 
 * All different text editor text properties and keybinds are modularly added here
 * 
*/


import { Editor } from './editor.js';
import { caretPositionFromPoint, getTextPositionFromHTMLPosition, getSelectionIndices } from './html_utilities.js';

// Exports a function that applies all of the event listeners of special keys and text properties
export function init(/** @type {boolean} */ read_only) {
  const editor = new Editor(read_only)
  window['editor'] = editor;

  const textbox = document.getElementById('shared-textbox');
  textbox.focus();

  textbox.addEventListener('click',
    (event) => {
      if (!editor.is_initialized()) return;
      if (document.getSelection().toString() !== '') return;

      let { node, position } = caretPositionFromPoint(event.clientX, event.clientY);
      let pos = getTextPositionFromHTMLPosition(node, position);

      if (pos < 0) pos = 0;
      if (pos > editor.content.length) pos = editor.content.length;

      editor.move_cursor(pos)
    },
  );

  textbox.addEventListener('keypress', (event) => {
    if (!editor.is_initialized()) return;

    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.remove(selectionRange.start, selectionRange.end);
      editor.move_cursor(selectionRange.start);
    }

    if (event.key === 'Enter') {
      editor.add('\n', editor.position)
    } else {
      editor.add(event.key, editor.position)
    }

    event.preventDefault();
  });

  textbox.addEventListener('keydown', (event) => {
    if (!editor.is_initialized()) return;

    switch (event.key) {
      case 'Backspace':
        if (document.getSelection().toString() !== '') {
          let selectionRange = getSelectionIndices();
          editor.remove(selectionRange.start, selectionRange.end);
          editor.move_cursor(selectionRange.start);
        } else if (event.ctrlKey) {
          editor.remove(editor.jump_position('backwards'), editor.position);
        } else if (editor.position !== 0) {
          editor.remove(editor.position - 1, editor.position);
        }

        break;
      case 'Delete':
        if (document.getSelection().toString() !== '') {
          let selectionRange = getSelectionIndices();
          editor.remove(selectionRange.start, selectionRange.end);
          editor.move_cursor(selectionRange.start);
        } else if (event.ctrlKey) {
          editor.remove(editor.position, editor.jump_position('forwards'));
        } else {
          editor.remove(editor.position, editor.position + 1);
        }
        break;

      case 'ArrowLeft':
        if (editor.position > 0) {
          if (event.ctrlKey) {
            editor.move_cursor(editor.jump_position('backwards'));
          } else {
            editor.move_cursor(editor.position - 1);
          }
        }
        break;

      case 'ArrowRight':
        if (editor.position < editor.content.length) {
          if (event.ctrlKey) {
            editor.move_cursor(editor.jump_position('forwards'));
          } else {
            editor.move_cursor(editor.position + 1);
          }
        }
        break;

      case 'ArrowUp':
        if (editor.position > 0) {
          const start_of_current_line = editor.step_while(/[^\n]/, 'backwards');
          if (start_of_current_line > 0) {
            const start_of_previous_line = editor.jump_line('backwards', start_of_current_line)

            editor.move_cursor(Math.min(start_of_current_line - 1, start_of_previous_line + (editor.position - start_of_current_line)));
          }
        }
        break;

      case 'ArrowDown':
        if (editor.position < editor.content.length) {
          const end_of_current_line = editor.step_while(/[^\n]/, 'forwards');
          const start_of_current_line = editor.step_while(/[^\n]/, 'backwards');
          const end_of_next_line = editor.jump_line('forwards', end_of_current_line)

          editor.move_cursor(Math.min(end_of_next_line, end_of_current_line + 1 + (editor.position - start_of_current_line)));
        }
        break;

      case 'Home':
        if (editor.position > 0) {
          if (event.ctrlKey) {
            editor.move_cursor(0);
          } else {
            editor.move_cursor(editor.jump_line('backwards'));
          }
        }
        break;

      case 'End':
        if (editor.position < editor.content.length) {
          if (event.ctrlKey) {
            editor.move_cursor(editor.content.length);
          } else {
            editor.move_cursor(editor.jump_line('forwards'));
          }
        }
        break;

      case 'Shift':
      case 'Control':
      case 'Alt':
        break;
      default:
        // window.getSelection().removeAllRanges();
        return;
    }
    event.preventDefault()
  });

  textbox.addEventListener('paste', function (event) {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.remove(selectionRange.start, selectionRange.end);
      editor.move_cursor(selectionRange.start);
    }

    // @ts-ignore
    let pastedData = event.clipboardData || window.clipboardData;
    editor.add(pastedData.getData('Text'), editor.position)
  });

  document.getElementById('font-family').addEventListener('change', (e) => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      // @ts-ignore
      editor.toggle_property(selectionRange.start, selectionRange.end, 'div', `style="display: inline-block; font-family:${e.target.value}"`);
    }
  });

  document.getElementById('confirm-font-size').addEventListener('click', (e) => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      // @ts-ignore
      editor.toggle_property(selectionRange.start, selectionRange.end, 'span', `style="font-size:${document.getElementById('font-size').value}px"`);
    }
  });

  document.getElementById('bold').addEventListener('click', () => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.toggle_property(selectionRange.start, selectionRange.end, 'b');
    }
  });

  document.getElementById('italic').addEventListener('click', () => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.toggle_property(selectionRange.start, selectionRange.end, 'i');
    }
  });

  document.getElementById('underline').addEventListener('click', () => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.toggle_property(selectionRange.start, selectionRange.end, 'u');
    }
  });

  document.getElementById('align-left').addEventListener('click', () => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.toggle_property(selectionRange.start, selectionRange.end, 'p', 'align="left"');
    }
  });

  document.getElementById('align-center').addEventListener('click', () => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.toggle_property(selectionRange.start, selectionRange.end, 'p', 'align="center"');
    }
  });

  document.getElementById('align-right').addEventListener('click', () => {
    if (document.getSelection().toString() !== '') {
      let selectionRange = getSelectionIndices();
      editor.toggle_property(selectionRange.start, selectionRange.end, 'p', 'align="right"');
    }
  });

}