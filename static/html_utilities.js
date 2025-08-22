/**
 * 
 * html_utilities.js
 * 
 * Contains useful functions that are called often when using the whiteboard and text editor 
 * 
 */

// Applies caretPositionFromPoint function with a different name depending on what the browser supports. Used to get text position in the html element you clicked.
export function caretPositionFromPoint(/** @type {number} */ x, /** @type {number} */ y) {
    // @ts-ignore
    if (document.caretPositionFromPoint) {
        // @ts-ignore
        let range = document.caretPositionFromPoint(x, y);
        return { node: range.offsetNode, position: range.offset };
    } else if (document.caretRangeFromPoint) {
        let range = document.caretRangeFromPoint(x, y);
        return { node: range.startContainer, position: range.startOffset };
    }
}

// Gets the position in the text editor from the position that was returned by caretPositionFromPoint
export function getTextPositionFromHTMLPosition(/** @type {Node} */ node, /** @type {number} */ pos) {
    const textbox = document.getElementById('shared-textbox');
    do {
        while (node.previousSibling) {
            node = node.previousSibling;
            if (node.textContent)
                pos += node.textContent.length;
        }

        node = node.parentNode;
    } while (node != textbox)

    return pos;
}

// Gets the start and end position of the text highlighted in a text editor 
export function getSelectionIndices() {
    let indices = { start: -1, end: -1 };
    let selection = window.getSelection();

    if (selection.rangeCount > 0) {
        let range = selection.getRangeAt(0);
        indices.start = getTextPositionFromHTMLPosition(range.startContainer, range.startOffset);
        indices.end = getTextPositionFromHTMLPosition(range.endContainer, range.endOffset);
    }

    return indices;
}

// Determines whether there is a point where two lines intersect
export function linesIntersect(
    /** @type { [number, number] } */ a1,
    /** @type { [number, number] } */ a2,
    /** @type { [number, number] } */ b1,
    /** @type { [number, number] } */ b2
) {
    var ua, ub, denom = (b2[1] - b1[1]) * (a2[0] - a1[0]) - (b2[0] - b1[0]) * (a2[1] - a1[1]);
    if (denom == 0)
        return false;

    ua = ((b2[0] - b1[0]) * (a1[1] - b1[1]) - (b2[1] - b1[1]) * (a1[0] - b1[0])) / denom;
    ub = ((a2[0] - a1[0]) * (a1[1] - b1[1]) - (a2[1] - a1[1]) * (a1[0] - b1[0])) / denom;
    return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

// Determines whether any points on a line intersect with a rectangle
export function lineIntersectsRectangle(
    /** @type { [number, number] } */ l1,
    /** @type { [number, number] } */ l2,
    /** @type { [number, number] } */ r1,
    /** @type { [number, number] } */ r2
) {
    return linesIntersect(l1, l2, r1, [r1[0], r2[1]])
        || linesIntersect(l1, l2, r1, [r2[0], r1[1]])
        || linesIntersect(l1, l2, [r1[0], r2[1]], r2)
        || linesIntersect(l1, l2, [r2[0], r1[1]], r2);
}

// Determines whether a point lies inside of a rectangle
export function pointInsideRectangle(
    /** @type { [number, number] } */ p,
    /** @type { [number, number] } */ r1,
    /** @type { [number, number] } */ r2
) {
    return r1[0] <= p[0] && p[0] <= r2[0] && r1[1] <= p[1] && p[1] <= r2[1];
}
