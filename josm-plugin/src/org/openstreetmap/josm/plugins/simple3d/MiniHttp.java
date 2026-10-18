package org.openstreetmap.josm.plugins.simple3d;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.openstreetmap.josm.tools.Logging;

/**
 * Простейший HTTP/1.1-сервер на сокетах: в Java, которая идёт с JOSM.app, нет модуля jdk.httpserver.
 * Одно соединение — один запрос (Connection: close); тело — только с Content-Length.
 */
final class MiniHttp {
    interface Handler {
        void handle(Exchange ex) throws IOException;
    }

    private final ServerSocket socket;
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "simple3d-http");
        t.setDaemon(true);
        return t;
    });

    MiniHttp(int port, Handler handler) throws IOException {
        socket = new ServerSocket(port, 50, InetAddress.getLoopbackAddress());
        Thread accept = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    Socket s = socket.accept();
                    pool.execute(() -> serve(s, handler));
                } catch (IOException e) {
                    if (!socket.isClosed()) Logging.warn("Simple3D: " + e);
                }
            }
        }, "simple3d-accept");
        accept.setDaemon(true);
        accept.start();
    }

    void stop() throws IOException {
        socket.close();
        pool.shutdownNow();
    }

    private static void serve(Socket s, Handler handler) {
        try (s) {
            s.setSoTimeout(60_000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            String start = line(in);
            if (start == null || start.isEmpty()) return;
            String[] parts = start.split(" ");
            if (parts.length < 2) return;
            Exchange ex = new Exchange(parts[0], URI.create(parts[1]), s.getOutputStream());
            int length = 0;
            for (String h; (h = line(in)) != null && !h.isEmpty();) {
                int i = h.indexOf(':');
                if (i > 0 && h.substring(0, i).trim().equalsIgnoreCase("Content-Length")) length = Integer.parseInt(h.substring(i + 1).trim());
            }
            ex.body = in.readNBytes(length);
            handler.handle(ex);
        } catch (Exception e) {
            Logging.debug("Simple3D: " + e);
        }
    }

    /** Строка заголовка до CRLF (ISO-8859-1, как требует HTTP). */
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1 && c != '\n') if (c != '\r') b.write(c);
        return c == -1 && b.size() == 0 ? null : b.toString(StandardCharsets.ISO_8859_1);
    }

    /** Запрос и ответ — с теми же методами, что у com.sun.net.httpserver.HttpExchange. */
    static final class Exchange {
        private final String method;
        private final URI uri;
        private final OutputStream out;
        private byte[] body = new byte[0];
        private final Headers headers = new Headers();
        private long remaining = -1;

        Exchange(String method, URI uri, OutputStream out) {
            this.method = method;
            this.uri = uri;
            this.out = out;
        }

        String getRequestMethod() {
            return method;
        }

        URI getRequestURI() {
            return uri;
        }

        InputStream getRequestBody() {
            return new ByteArrayInputStream(body);
        }

        Headers getResponseHeaders() {
            return headers;
        }

        /** length -1 — без тела. */
        void sendResponseHeaders(int status, long length) throws IOException {
            StringBuilder sb = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
            for (String[] h : headers.list) sb.append(h[0]).append(": ").append(h[1]).append("\r\n");
            sb.append("Content-Length: ").append(Math.max(0, length)).append("\r\nConnection: close\r\n\r\n");
            out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
            remaining = length;
            if (length <= 0) out.flush();
        }

        OutputStream getResponseBody() {
            return new OutputStream() {
                @Override
                public void write(int b) throws IOException {
                    out.write(b);
                }

                @Override
                public void write(byte[] b, int off, int len) throws IOException {
                    out.write(b, off, len);
                }

                @Override
                public void close() throws IOException {
                    out.flush();
                }
            };
        }

        void close() {
            try {
                out.flush();
            } catch (IOException e) {
                Logging.trace(e);
            }
        }

        private static String reason(int status) {
            switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 409: return "Conflict";
            default: return status >= 500 ? "Server Error" : "Status";
            }
        }
    }

    static final class Headers {
        private final List<String[]> list = new ArrayList<>();

        void add(String key, String value) {
            list.add(new String[] {key, value});
        }

        @Override
        public String toString() {
            return list.toString().toLowerCase(Locale.ROOT);
        }
    }
}
