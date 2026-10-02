import { createHost } from './host.js';

const onMessage = createHost((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => onMessage(e.data);
