export function setupBundledRuntimePath({ services = globalThis.Services, fileInterface = globalThis.Ci?.nsIFile } = {}) {
  if (services?.appinfo?.OS !== "WINNT") return [];
  try {
    const root = services.dirsvc.get("GreD", fileInterface);
    const directories = [];
    for (const [name, executable] of [["node", "node.exe"], ["python", "python.exe"]]) {
      const directory = root.clone();
      directory.append("runtimes");
      directory.append(name);
      const file = directory.clone();
      file.append(executable);
      if (file.exists() && file.isFile()) directories.push(directory.path);
    }
    if (!directories.length) return [];
    const seen = new Set();
    const path = [...directories, ...(services.env.get("PATH") || "").split(";")]
      .filter(part => {
        const key = part.replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).join(";");
    services.env.set("PATH", path);
    return directories;
  } catch {
    return [];
  }
}
