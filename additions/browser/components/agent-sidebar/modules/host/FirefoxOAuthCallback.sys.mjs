/* Loopback-only OAuth callback; no callback URL is logged or reflected. */
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

export function listenForOAuthCallback(onRedirect) {
  const sockets = [];
  const connections = new Set();
  function close() {
    for (const socket of sockets) socket.close();
    for (const connection of [...connections]) connection();
  }
  const listener = {
    onSocketAccepted(_server, transport) {
      if (connections.size >= 16) { transport.close(Cr.NS_ERROR_ABORT); return; }
      const input = transport.openInputStream(0, 0, 0);
      const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
      const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      reader.init(input);
      let finished = false;
      let headers = "";
      let cleaned = false;
      const cleanup = (force = true) => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timer);
        connections.delete(cleanup);
        if (force) transport.close(Cr.NS_OK);
        else input.close();
      };
      const timer = setTimeout(cleanup, 10000);
      connections.add(cleanup);
      pump.init(input, 0, 0, true);
      pump.asyncRead({
        onStartRequest() {},
        onDataAvailable(_request, _stream, _offset, count) {
          if (finished) return;
          headers += reader.read(count);
          if (headers.length > 8192) { finished = true; cleanup(); return; }
          if (!headers.includes("\r\n\r\n")) return;
          finished = true;
          let status = "400 Bad Request";
          let message = "Invalid OAuth callback. Return to the Agent settings and retry.";
          const request = /^GET (\/auth\/callback\?[^\s]+) HTTP\/1\.[01]\r\n/.exec(headers);
          const host = /^Host:\s*localhost:1455\s*$/im.test(headers);
          if (request && host) {
            try {
              onRedirect("http://localhost:1455" + request[1]);
              status = "200 OK";
              message = "Authorization received. Return to the Agent settings to check sign-in completion.";
            } catch {}
          }
          const response = "HTTP/1.1 " + status + "\r\nContent-Type: text/plain; charset=utf-8\r\n" +
            "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n" +
            "Content-Length: " + message.length + "\r\n\r\n" + message;
          const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
          try { output.write(response, response.length); } finally { output.close(); cleanup(false); }
        },
        onStopRequest() { cleanup(); },
      });
    },
    onStopListening() {},
  };
  try {
    const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    socket.init(1455, true, -1);
    sockets.push(socket);
    socket.asyncListen(listener);
    try {
      const ipv6 = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      ipv6.initIPv6(1455, true, -1);
      sockets.push(ipv6);
      ipv6.asyncListen(listener);
    } catch {}
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
