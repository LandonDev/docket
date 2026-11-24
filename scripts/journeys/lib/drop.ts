import type { Window } from './window'

type Point = { x: number; y: number }

export function rowDrop(page: Window, from: Point, to: Point): Promise<void> {
  return page.eval(`(() => {
    const from = ${JSON.stringify(from)}, to = ${JSON.stringify(to)};
    const source = document.elementFromPoint(from.x, from.y)?.closest('[draggable="true"]');
    const target = document.elementFromPoint(to.x, to.y);
    if (!source || !target) throw new Error('The drag source or target has no row');
    const dataTransfer = new DataTransfer();
    const event = (type, point) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: point.x, clientY: point.y });
    try {
      source.dispatchEvent(event('dragstart', from));
      target.dispatchEvent(event('dragenter', to));
      target.dispatchEvent(event('dragover', to));
      target.dispatchEvent(event('drop', to));
    } finally {
      source.dispatchEvent(event('dragend', to));
    }
  })()`)
}

export function desktopDrop(page: Window, target: string, name: string, mime: string, bytes: Uint8Array): Promise<void> {
  return page.eval(`(() => {
    const target = document.querySelector(${JSON.stringify(target)});
    if (!target) throw new Error('The desktop drop target is missing');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(${JSON.stringify([...bytes])})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
  })()`)
}
