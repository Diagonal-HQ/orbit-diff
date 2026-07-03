import { useEffect, useState } from "react";

// Track terminal size and re-render on resize. Ink doesn't expose rows/cols
// reactively, so we listen on stdout's "resize" event ourselves.
export function useDimensions() {
  const [size, setSize] = useState({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  useEffect(() => {
    const onResize = () =>
      setSize({
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
    process.stdout.on("resize", onResize);
    return () => process.stdout.off("resize", onResize);
  }, []);

  return size;
}
