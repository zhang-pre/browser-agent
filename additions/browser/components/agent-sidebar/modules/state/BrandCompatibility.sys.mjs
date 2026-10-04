// Compatibility with installations created before the product rename.
// Keep the historical identifier assembled here so active names have one spelling.
export const LEGACY_PRODUCT = ["firefox", "reverse"].join("-");

// Existing profiles keep using their data directory; fresh profiles use the new name.
// Resolve the directory itself before appending filenames to avoid splitting data.
export function dataDirectory(parent, name) {
  const current = PathUtils.join(parent, name);
  if (typeof Cc === "undefined" || typeof Ci === "undefined") return current;
  const exists = path => {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.exists() && file.isDirectory();
  };
  const legacy = PathUtils.join(parent, name.replace("browser-agent", LEGACY_PRODUCT));
  return !exists(current) && exists(legacy) ? legacy : current;
}
