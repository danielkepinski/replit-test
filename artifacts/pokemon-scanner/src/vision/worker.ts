// Web worker for heavy vision processing if needed in future.
// Currently, detection runs on main thread to share OpenCV instance efficiently.
self.onmessage = (e) => {
  if (e.data.type === 'PING') {
    self.postMessage({ type: 'PONG' });
  }
};
export {};
