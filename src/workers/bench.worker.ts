import { BenchRequest, handleRequest } from '../engine/bench';

self.onmessage = (e: MessageEvent<BenchRequest>) => {
  handleRequest(e.data, (m) => (self as unknown as Worker).postMessage(m));
};
