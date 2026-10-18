package org.openstreetmap.josm.plugins.simple3d;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.swing.SwingUtilities;
import javax.xml.parsers.DocumentBuilderFactory;

import org.openstreetmap.josm.command.AddCommand;
import org.openstreetmap.josm.command.ChangeMembersCommand;
import org.openstreetmap.josm.command.ChangeNodesCommand;
import org.openstreetmap.josm.command.ChangePropertyCommand;
import org.openstreetmap.josm.command.Command;
import org.openstreetmap.josm.command.DeleteCommand;
import org.openstreetmap.josm.command.MoveCommand;
import org.openstreetmap.josm.command.SequenceCommand;
import org.openstreetmap.josm.data.UndoRedoHandler;
import org.openstreetmap.josm.data.coor.LatLon;
import org.openstreetmap.josm.data.osm.DataSet;
import org.openstreetmap.josm.data.osm.Node;
import org.openstreetmap.josm.data.osm.OsmPrimitive;
import org.openstreetmap.josm.data.osm.OsmPrimitiveType;
import org.openstreetmap.josm.data.osm.Relation;
import org.openstreetmap.josm.data.osm.RelationMember;
import org.openstreetmap.josm.data.osm.SimplePrimitiveId;
import org.openstreetmap.josm.data.osm.Way;
import org.openstreetmap.josm.data.osm.event.DataSetListenerAdapter;
import org.openstreetmap.josm.gui.MainApplication;
import org.openstreetmap.josm.gui.layer.MainLayerManager.ActiveLayerChangeListener;
import org.openstreetmap.josm.io.OsmWriter;
import org.openstreetmap.josm.io.OsmWriterFactory;
import org.openstreetmap.josm.tools.Logging;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

import org.openstreetmap.josm.plugins.simple3d.MiniHttp.Exchange;

/**
 * HTTP только на 127.0.0.1:
 * <ul>
 * <li>GET /simple3d/status — версия протокола и номер ревизии слоя (rev растёт при любом изменении данных);</li>
 * <li>GET /simple3d/export[?since=rev] — активный слой в .osm; с since ждёт изменения до 25 с (иначе 204);</li>
 * <li>POST /simple3d/undo, /simple3d/redo — отмена/повтор в JOSM;</li>
 * <li>/api/0.6/… — подмножество OSM API, которым пользуется отправка редактора: nodes/ways/relations.json,
 * way/{id}/relations.json, changeset create/upload/close. Загрузка osmChange — одна команда JOSM.</li>
 * </ul>
 */
class BridgeServer {
    /**
     * Версия протокола: растёт при несовместимых изменениях и при новых возможностях, без которых редактор не обойдётся
     * (редактор знает минимальную, MIN_PROTOCOL в src/osm/josm.ts). 2 — выделение, история, пользователь в status.
     */
    static final int PROTOCOL = 2;

    private final int port;
    private MiniHttp http;
    private final Object revLock = new Object();
    private long rev = 1;
    private DataSet watched;
    private final DataSetListenerAdapter dsListener = new DataSetListenerAdapter(e -> bump());
    /** Ревизия выделения в JOSM (отдельно от данных: выделение меняется чаще и без перезагрузки слоя). */
    private long selRev = 1;
    private final org.openstreetmap.josm.data.osm.DataSelectionListener selListener = e -> bumpSelection();
    private final ActiveLayerChangeListener layerListener = e -> {
        DataSet ds = MainApplication.getLayerManager().getEditDataSet();
        if (ds != watched) {
            if (watched != null) {
                watched.removeDataSetListener(dsListener);
                watched.removeSelectionListener(selListener);
            }
            watched = ds;
            if (ds != null) {
                ds.addDataSetListener(dsListener);
                ds.addSelectionListener(selListener);
            }
        }
        bump();
        bumpSelection();
    };

    BridgeServer(int port) {
        this.port = port;
    }

    void start() throws IOException {
        http = new MiniHttp(port, this::handle);
        MainApplication.getLayerManager().addAndFireActiveLayerChangeListener(layerListener);
        Logging.info("Simple3D: слушаю 127.0.0.1:" + port);
    }

    private void bump() {
        synchronized (revLock) {
            rev++;
            revLock.notifyAll();
        }
    }

    private void bumpSelection() {
        synchronized (revLock) {
            selRev++;
            revLock.notifyAll();
        }
    }

    private long rev() {
        synchronized (revLock) {
            return rev;
        }
    }

    // ---------------------------------------------------------------- HTTP

    private void handle(Exchange ex) throws IOException {
        try {
            String origin = ex.getRequestHeader("Origin");
            if (origin != null && !allowedOrigin(origin)) {
                send(ex, 403, "text/plain", "origin not allowed: " + origin + " (JOSM preference simple3d.origins)");
                return;
            }
            ex.getResponseHeaders().add("Access-Control-Allow-Origin", origin != null ? origin : "*");
            ex.getResponseHeaders().add("Vary", "Origin");
            ex.getResponseHeaders().add("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
            ex.getResponseHeaders().add("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
            ex.getResponseHeaders().add("Access-Control-Allow-Private-Network", "true");
            ex.getResponseHeaders().add("Access-Control-Expose-Headers", "X-Simple3D-Rev");
            if ("OPTIONS".equals(ex.getRequestMethod())) {
                send(ex, 204, null, null);
                return;
            }
            route(ex);
        } catch (HttpError e) {
            ex.getResponseHeaders().add("Cache-Control", "no-store");
            send(ex, e.status, "text/plain", e.getMessage());
        } catch (Exception e) {
            Logging.error(e);
            ex.getResponseHeaders().add("Cache-Control", "no-store");
            send(ex, 500, "text/plain", String.valueOf(e));
        } finally {
            ex.close();
        }
    }

    private void route(Exchange ex) throws Exception {
        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod();
        Map<String, String> q = query(ex.getRequestURI().getRawQuery());
        if (path.equals("/editor")) {
            ex.getResponseHeaders().add("Location", "/editor/");
            send(ex, 302, "text/plain", "");
            return;
        }
        if (path.startsWith("/editor/") && method.equals("GET")) {
            proxyEditor(ex, path.substring("/editor/".length()));
            return;
        }
        if (path.equals("/simple3d/status")) {
            send(ex, 200, "application/json", status());
            return;
        }
        if (path.equals("/simple3d/selection") && method.equals("GET")) {
            selection(ex, q.get("since"));
            return;
        }
        if (path.equals("/simple3d/selection") && method.equals("POST")) {
            select(new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8));
            send(ex, 200, "text/plain", "");
            return;
        }
        if (path.equals("/simple3d/export")) {
            export(ex, q.get("since"));
            return;
        }
        if (path.equals("/simple3d/undo") && method.equals("POST")) {
            onEdt(() -> UndoRedoHandler.getInstance().undo());
            send(ex, 200, "text/plain", "");
            return;
        }
        if (path.equals("/simple3d/redo") && method.equals("POST")) {
            onEdt(() -> UndoRedoHandler.getInstance().redo());
            send(ex, 200, "text/plain", "");
            return;
        }
        String api = "/api/0.6/";
        if (!path.startsWith(api)) throw new HttpError(404, "not found");
        String p = path.substring(api.length());
        DataSet ds = editDataSet();
        Matcher m;
        if ((m = Pattern.compile("(node|way|relation)s\\.json").matcher(p)).matches()) {
            String type = m.group(1);
            List<OsmPrimitive> found = new ArrayList<>();
            readLocked(ds, () -> {
                for (String id : Objects.requireNonNullElse(q.get(type + "s"), "").split(",")) {
                    if (id.isEmpty()) continue;
                    OsmPrimitive o = ds.getPrimitiveById(new SimplePrimitiveId(Long.parseLong(id), OsmPrimitiveType.from(type)));
                    if (o != null && live(o)) found.add(o);
                }
            });
            send(ex, 200, "application/json", elementsJson(ds, found));
        } else if ((m = Pattern.compile("way/(-?\\d+)/relations\\.json").matcher(p)).matches()) {
            List<OsmPrimitive> found = new ArrayList<>();
            long id = Long.parseLong(m.group(1));
            readLocked(ds, () -> {
                OsmPrimitive w = ds.getPrimitiveById(new SimplePrimitiveId(id, OsmPrimitiveType.WAY));
                if (w != null) for (OsmPrimitive r : w.getReferrers()) if (r instanceof Relation && live(r)) found.add(r);
            });
            send(ex, 200, "application/json", elementsJson(ds, found));
        } else if (p.equals("changeset/create") && method.equals("PUT")) {
            // Комментарий пакета (редактор предлагает его по правкам) — имя команды в истории JOSM
            Matcher c = Pattern.compile("k=\"comment\"\\s+v=\"([^\"]*)\"").matcher(new String(readAll(ex.getRequestBody()), StandardCharsets.UTF_8));
            label = c.find() ? String.join("; ", java.util.Arrays.stream(unescapeXml(c.group(1)).split("\n"))
                .map(l -> l.replaceFirst("^\\s*[*•-]\\s*", "").replaceFirst(":$", "").trim()).filter(l -> !l.isEmpty()).toArray(String[]::new)) : "";
            send(ex, 200, "text/plain", "1");
        } else if (p.matches("changeset/\\d+/close") && method.equals("PUT")) {
            send(ex, 200, "text/plain", "");
        } else if (p.matches("changeset/\\d+/upload") && method.equals("POST")) {
            byte[] body = readAll(ex.getRequestBody());
            String result = applyOsmChange(ds, body);
            send(ex, 200, "application/xml", result);
        } else {
            throw new HttpError(404, "not supported: " + method + " " + path);
        }
    }

    /**
     * Состояние: ревизия слоя, есть ли слой, пользователь и сервер JOSM (адрес API — редактор по нему выбирает
     * подложку), история команд JOSM — она же общая история правок: в неё попадают и правки из 3D.
     */
    private String status() throws Exception {
        StringBuilder sb = new StringBuilder("{\"plugin\":\"simple3d\",\"protocol\":").append(PROTOCOL).append(",\"rev\":").append(rev());
        AtomicReference<String> extra = new AtomicReference<>();
        onEdt(() -> {
            DataSet ds = MainApplication.getLayerManager().getEditDataSet();
            UndoRedoHandler h = UndoRedoHandler.getInstance();
            List<Command> undo = h.getUndoCommands(), redo = h.getRedoCommands();
            org.openstreetmap.josm.data.UserIdentityManager u = org.openstreetmap.josm.data.UserIdentityManager.getInstance();
            // Вход по OAuth: имя JOSM узнаёт запросом к серверу — попросим его один раз (в фоне, не на EDT)
            if (u.isAnonymous() && !askedIdentity) {
                askedIdentity = true;
                Thread t = new Thread(u::initFromOAuth, "simple3d-identity");
                t.setDaemon(true);
                t.start();
            }
            extra.set(",\"layer\":" + (ds != null)
                + (ds != null ? ",\"layerName\":" + str(MainApplication.getLayerManager().getEditLayer().getName()) : "")
                + ",\"api\":" + str(org.openstreetmap.josm.io.OsmApi.getOsmApi().getBaseUrl())
                + (u.isAnonymous() || u.getUserName() == null ? "" : ",\"user\":" + str(u.getUserName()))
                + ",\"undo\":" + undo.size() + ",\"redo\":" + redo.size()
                + (undo.isEmpty() ? "" : ",\"undoName\":" + str(undo.get(undo.size() - 1).getDescriptionText()))
                + (redo.isEmpty() ? "" : ",\"redoName\":" + str(redo.get(0).getDescriptionText())));
        });
        return sb.append(extra.get()).append('}').toString();
    }

    /** Выделение в JOSM: ключи type/id; since — ждать изменения после этой ревизии (до 25 с, иначе 204). */
    /** Открытый редактор всё время ждёт выделение (долгий опрос): сколько таких запросов сейчас и когда был последний. */
    private int editorWaiting;
    private volatile long editorSeen;
    /** Вид, к которому перейти открытому редактору (повторный выбор пункта меню), и его номер. */
    private String view;
    private long viewSeq;

    /** Редактор открыт: ждёт выделение сейчас или ждал только что (между запросами). */
    boolean editorOpen() {
        synchronized (revLock) {
            return editorWaiting > 0 || System.currentTimeMillis() - editorSeen < 4000;
        }
    }

    /** Перевести открытый редактор к виду JOSM: он получит его вместе с выделением. */
    void goTo(double lat, double lon, double zoom) {
        synchronized (revLock) {
            view = String.format(java.util.Locale.ROOT, "{\"lat\":%.7f,\"lon\":%.7f,\"zoom\":%.2f}", lat, lon, zoom);
            viewSeq++;
            selRev++;
            revLock.notifyAll();
        }
    }

    private void selection(Exchange ex, String since) throws Exception {
        synchronized (revLock) {
            editorWaiting++;
            editorSeen = System.currentTimeMillis();
        }
        try {
            selectionInner(ex, since);
        } finally {
            synchronized (revLock) {
                editorWaiting--;
                editorSeen = System.currentTimeMillis();
            }
        }
    }

    private void selectionInner(Exchange ex, String since) throws Exception {
        if (since != null) {
            long s = Long.parseLong(since);
            long deadline = System.currentTimeMillis() + 25_000;
            synchronized (revLock) {
                while (selRev == s) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    revLock.wait(left);
                }
                if (selRev == s) {
                    send(ex, 204, null, null);
                    return;
                }
            }
        }
        long r, vs;
        String v;
        synchronized (revLock) {
            r = selRev;
            vs = viewSeq;
            v = view;
        }
        StringBuilder sb = new StringBuilder("{\"rev\":").append(r).append(",\"viewSeq\":").append(vs)
            .append(v != null ? ",\"view\":" + v : "").append(",\"keys\":[");
        DataSet ds = MainApplication.getLayerManager().getEditDataSet();
        if (ds != null) {
            readLocked(ds, () -> {
                boolean first = true;
                for (OsmPrimitive p : ds.getAllSelected()) {
                    sb.append(first ? "" : ",").append(str(p.getType().getAPIName() + "/" + p.getUniqueId()));
                    first = false;
                }
            });
        }
        send(ex, 200, "application/json", sb.append("]}").toString());
    }

    /** Выделить в JOSM объекты из редактора: ключи type/id через запятую или с новой строки; пусто — снять выделение. */
    private static void select(String body) throws Exception {
        DataSet ds = editDataSet();
        List<OsmPrimitive> found = new ArrayList<>();
        for (String k : body.split("[,\\s]+")) {
            String[] t = k.trim().split("/");
            if (t.length != 2) continue;
            OsmPrimitive p = ds.getPrimitiveById(new SimplePrimitiveId(Long.parseLong(t[1]), OsmPrimitiveType.from(t[0])));
            if (p != null && live(p)) found.add(p);
        }
        onEdt(() -> {
            if (new HashSet<>(ds.getAllSelected()).equals(new HashSet<>(found))) return;
            ds.setSelected(found);
        });
    }

    /** Кому можно обращаться: сайт редактора (simple3d.url), сам плагин, localhost (разработка) и simple3d.origins. */
    private boolean allowedOrigin(String origin) {
        if (origin.equals("http://127.0.0.1:" + port) || origin.matches("https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?")) return true;
        try {
            java.net.URI u = java.net.URI.create(Simple3DPlugin.EDITOR_URL.get());
            if (origin.equals(u.getScheme() + "://" + u.getAuthority())) return true;
        } catch (IllegalArgumentException e) {
            Logging.trace(e);
        }
        for (String o : Simple3DPlugin.ORIGINS.get().split("[,\\s]+")) if (!o.isEmpty() && origin.equals(o)) return true;
        return false;
    }

    private void export(Exchange ex, String since) throws Exception {
        if (since != null) {
            long s = Long.parseLong(since);
            long deadline = System.currentTimeMillis() + 25_000;
            synchronized (revLock) {
                while (rev == s) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    revLock.wait(left);
                }
            }
            if (rev() == s) {
                ex.getResponseHeaders().add("X-Simple3D-Rev", String.valueOf(s));
                send(ex, 204, null, null);
                return;
            }
        }
        long r = rev();
        DataSet ds = MainApplication.getLayerManager().getEditDataSet();
        StringWriter sw = new StringWriter();
        if (ds != null) {
            readLocked(ds, () -> {
                try (OsmWriter w = OsmWriterFactory.createOsmWriter(new PrintWriter(sw), false, "0.6")) {
                    w.header();
                    w.writeDataSources(ds);
                    w.writeContent(ds);
                    w.footer();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
        }
        ex.getResponseHeaders().add("X-Simple3D-Rev", String.valueOf(r));
        send(ex, 200, "application/xml; charset=utf-8", sw.toString());
    }

    // ---------------------------------------------------------------- osmChange → команды JOSM

    /** Ключ элемента osmChange: тип/id (id — как прислал редактор, у новых отрицательный). */
    private static String key(String type, long id) {
        return type + "/" + id;
    }

    private volatile boolean askedIdentity;

    /** Объекты, которые меняли правки из 3D (слабые ссылки: удалённые из слоя забываются). */
    private final Set<OsmPrimitive> touched = java.util.Collections.synchronizedSet(java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>()));

    /** Хештег пакета правок, в котором есть правки из 3D, — как у отправки из самого редактора. */
    static final String HASHTAG = "#simple3d";

    /**
     * Перед отправкой из JOSM: если среди отправляемых есть объекты, которые меняли правки из 3D, — #simple3d
     * в теге hashtags пакета правок (через «;», как пишет JOSM).
     */
    org.openstreetmap.josm.actions.upload.UploadHook uploadHook() {
        return new org.openstreetmap.josm.actions.upload.UploadHook() {
            @Override
            public void modifyChangesetTags(Map<String, String> tags) {
                DataSet ds = MainApplication.getLayerManager().getEditDataSet();
                if (ds == null || touched.isEmpty()) return;
                boolean ours;
                synchronized (touched) {
                    ours = ds.allModifiedPrimitives().stream().anyMatch(touched::contains);
                }
                if (!ours) return;
                String h = tags.getOrDefault("hashtags", "");
                if (java.util.Arrays.stream(h.split(";")).anyMatch(t -> t.trim().equalsIgnoreCase(HASHTAG))) return;
                tags.put("hashtags", h.isBlank() ? HASHTAG : h + ";" + HASHTAG);
            }
        };
    }

    /** Имя следующей команды (комментарий из changeset/create). */
    private volatile String label = "";

    private static String unescapeXml(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
    }

    private String applyOsmChange(DataSet ds, byte[] body) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        Document doc = f.newDocumentBuilder().parse(new ByteArrayInputStream(body));
        AtomicReference<String> out = new AtomicReference<>();
        AtomicReference<Exception> err = new AtomicReference<>();
        onEdt(() -> {
            ds.beginUpdate();
            try {
                out.set(buildAndRun(ds, doc));
            } catch (Exception e) {
                err.set(e);
            } finally {
                ds.endUpdate();
            }
        });
        if (err.get() != null) throw err.get();
        return out.get();
    }

    private String buildAndRun(DataSet ds, Document doc) throws HttpError {
        Map<String, OsmPrimitive> created = new HashMap<>();
        List<Command> cmds = new ArrayList<>();
        StringBuilder diff = new StringBuilder("<diffResult version=\"0.6\" generator=\"JOSM simple3d\">");
        List<Element> creates = children(doc.getDocumentElement(), "create");
        List<Element> modifies = children(doc.getDocumentElement(), "modify");
        List<Element> deletes = children(doc.getDocumentElement(), "delete");

        // Создание: сначала объекты без связей (в том же порядке — узлы, пути, отношения), потом связи
        List<Element> newEls = new ArrayList<>();
        for (Element block : creates) newEls.addAll(elements(block));
        for (Element e : newEls) {
            OsmPrimitive p;
            switch (e.getTagName()) {
            case "node": p = new Node(latLon(e)); break;
            case "way": p = new Way(); break;
            case "relation": p = new Relation(); break;
            default: continue;
            }
            p.setKeys(tags(e));
            created.put(key(e.getTagName(), id(e)), p);
        }
        for (Element e : newEls) {
            OsmPrimitive p = created.get(key(e.getTagName(), id(e)));
            if (p instanceof Way) ((Way) p).setNodes(wayNodes(ds, created, e));
            if (p instanceof Relation) ((Relation) p).setMembers(members(ds, created, e));
        }
        // Добавлять так, чтобы всё, на что ссылаются, уже было в слое
        Set<OsmPrimitive> added = new HashSet<>();
        List<OsmPrimitive> pending = new ArrayList<>(created.values());
        pending.sort((a, b) -> rank(a) - rank(b));
        while (!pending.isEmpty()) {
            boolean progress = false;
            for (var it = pending.iterator(); it.hasNext();) {
                OsmPrimitive p = it.next();
                boolean ready = true;
                if (p instanceof Relation) {
                    for (RelationMember m : ((Relation) p).getMembers()) {
                        if (created.containsValue(m.getMember()) && !added.contains(m.getMember())) ready = false;
                    }
                }
                if (!ready) continue;
                cmds.add(new AddCommand(ds, p));
                added.add(p);
                it.remove();
                progress = true;
            }
            if (!progress) throw new HttpError(400, "relation cycle among created relations");
        }

        // Изменение: координаты, состав, теги — только то, что действительно отличается
        for (Element block : modifies) {
            for (Element e : elements(block)) {
                OsmPrimitive p = existing(ds, created, e);
                if (p instanceof Node) {
                    LatLon ll = latLon(e);
                    if (!((Node) p).getCoor().equalsEpsilon(ll)) cmds.add(new MoveCommand((Node) p, ll));
                } else if (p instanceof Way) {
                    List<Node> nodes = wayNodes(ds, created, e);
                    if (!nodes.equals(((Way) p).getNodes())) cmds.add(new ChangeNodesCommand(ds, (Way) p, nodes));
                } else if (p instanceof Relation) {
                    List<RelationMember> members = members(ds, created, e);
                    if (!members.equals(((Relation) p).getMembers())) cmds.add(new ChangeMembersCommand(ds, (Relation) p, members));
                }
                Node holder = new Node();
                holder.setKeys(tags(e));
                if (!p.getKeys().equals(holder.getKeys())) {
                    Command c = ChangePropertyCommand.build(p, holder);
                    if (c != null) cmds.add(c);
                }
                diff.append('<').append(e.getTagName()).append(" old_id=\"").append(id(e)).append("\" new_id=\"")
                    .append(p.getUniqueId()).append("\" new_version=\"").append(p.getVersion()).append("\"/>");
            }
        }

        // Удаление (if-unused): пропускаем то, на что ещё ссылаются объекты вне удаляемых
        Set<OsmPrimitive> toDelete = new LinkedHashSet<>();
        List<Element> delEls = new ArrayList<>();
        for (Element block : deletes) delEls.addAll(elements(block));
        for (Element e : delEls) {
            OsmPrimitive p = ds.getPrimitiveById(new SimplePrimitiveId(id(e), OsmPrimitiveType.from(e.getTagName())));
            if (p != null && live(p)) toDelete.add(p);
        }
        boolean changed;
        do {
            changed = false;
            for (var it = toDelete.iterator(); it.hasNext();) {
                OsmPrimitive p = it.next();
                for (OsmPrimitive r : p.getReferrers()) {
                    if (live(r) && !toDelete.contains(r)) {
                        it.remove();
                        changed = true;
                        break;
                    }
                }
            }
        } while (changed);
        if (!toDelete.isEmpty()) cmds.add(new DeleteCommand(ds, toDelete));
        for (OsmPrimitive p : toDelete) {
            diff.append('<').append(p.getType().getAPIName()).append(" old_id=\"").append(p.getUniqueId()).append("\"/>");
        }

        if (!cmds.isEmpty()) {
            String name = "3D: " + (label.isEmpty() ? "Simple3D" : label);
            SequenceCommand seq = new SequenceCommand(ds, name, cmds, false) {
                @Override
                public String getDescriptionText() {
                    return name;
                }
            };
            UndoRedoHandler.getInstance().add(seq);
            touched.addAll(seq.getParticipatingPrimitives());
        }
        // Новым объектам JOSM выдал свои временные id — сообщаем их как new_id
        for (Element e : newEls) {
            OsmPrimitive p = created.get(key(e.getTagName(), id(e)));
            diff.append('<').append(e.getTagName()).append(" old_id=\"").append(id(e)).append("\" new_id=\"")
                .append(p.getUniqueId()).append("\" new_version=\"0\"/>");
        }
        return diff.append("</diffResult>").toString();
    }

    /** Есть в слое и скачан целиком (isUsable не годится: скрытые фильтром JOSM тоже «не usable»). */
    private static boolean live(OsmPrimitive p) {
        return !p.isDeleted() && !p.isIncomplete();
    }

    private static int rank(OsmPrimitive p) {
        return p instanceof Node ? 0 : p instanceof Way ? 1 : 2;
    }

    private static OsmPrimitive resolve(DataSet ds, Map<String, OsmPrimitive> created, String type, long id) throws HttpError {
        OsmPrimitive p = created.get(key(type, id));
        if (p == null) p = ds.getPrimitiveById(new SimplePrimitiveId(id, OsmPrimitiveType.from(type)));
        if (p == null || p.isDeleted()) throw new HttpError(409, type + "/" + id + " is not in the JOSM layer");
        return p;
    }

    private static OsmPrimitive existing(DataSet ds, Map<String, OsmPrimitive> created, Element e) throws HttpError {
        return resolve(ds, created, e.getTagName(), id(e));
    }

    private static List<Node> wayNodes(DataSet ds, Map<String, OsmPrimitive> created, Element e) throws HttpError {
        List<Node> out = new ArrayList<>();
        for (Element nd : children(e, "nd")) out.add((Node) resolve(ds, created, "node", Long.parseLong(nd.getAttribute("ref"))));
        return out;
    }

    private static List<RelationMember> members(DataSet ds, Map<String, OsmPrimitive> created, Element e) throws HttpError {
        List<RelationMember> out = new ArrayList<>();
        for (Element m : children(e, "member")) {
            out.add(new RelationMember(m.getAttribute("role"), resolve(ds, created, m.getAttribute("type"), Long.parseLong(m.getAttribute("ref")))));
        }
        return out;
    }

    private static Map<String, String> tags(Element e) {
        Map<String, String> out = new HashMap<>();
        for (Element t : children(e, "tag")) out.put(t.getAttribute("k"), t.getAttribute("v"));
        return out;
    }

    private static LatLon latLon(Element e) {
        return new LatLon(Double.parseDouble(e.getAttribute("lat")), Double.parseDouble(e.getAttribute("lon")));
    }

    private static long id(Element e) {
        return Long.parseLong(e.getAttribute("id"));
    }

    private static List<Element> elements(Element block) {
        List<Element> out = new ArrayList<>();
        for (org.w3c.dom.Node n = block.getFirstChild(); n != null; n = n.getNextSibling()) if (n instanceof Element) out.add((Element) n);
        return out;
    }

    private static List<Element> children(Element e, String tag) {
        List<Element> out = new ArrayList<>();
        for (Element c : elements(e)) if (c.getTagName().equals(tag)) out.add(c);
        return out;
    }

    // ---------------------------------------------------------------- JSON в форме OSM API

    private static String elementsJson(DataSet ds, Collection<OsmPrimitive> items) {
        StringBuilder sb = new StringBuilder("{\"version\":\"0.6\",\"generator\":\"JOSM simple3d\",\"elements\":[");
        readLocked(ds, () -> {
            boolean first = true;
            for (OsmPrimitive p : items) {
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"type\":\"").append(p.getType().getAPIName()).append("\",\"id\":").append(p.getUniqueId())
                    .append(",\"version\":").append(p.getVersion());
                if (p instanceof Node) {
                    LatLon c = ((Node) p).getCoor();
                    sb.append(",\"lat\":").append(c.lat()).append(",\"lon\":").append(c.lon());
                } else if (p instanceof Way) {
                    sb.append(",\"nodes\":[");
                    List<Node> nodes = ((Way) p).getNodes();
                    for (int i = 0; i < nodes.size(); i++) sb.append(i > 0 ? "," : "").append(nodes.get(i).getUniqueId());
                    sb.append(']');
                } else if (p instanceof Relation) {
                    sb.append(",\"members\":[");
                    List<RelationMember> ms = ((Relation) p).getMembers();
                    for (int i = 0; i < ms.size(); i++) {
                        RelationMember m = ms.get(i);
                        sb.append(i > 0 ? "," : "").append("{\"type\":\"").append(m.getType().getAPIName()).append("\",\"ref\":")
                            .append(m.getUniqueId()).append(",\"role\":").append(str(m.getRole())).append('}');
                    }
                    sb.append(']');
                }
                if (p.hasKeys()) {
                    sb.append(",\"tags\":{");
                    boolean ft = true;
                    for (Map.Entry<String, String> t : p.getKeys().entrySet()) {
                        sb.append(ft ? "" : ",").append(str(t.getKey())).append(':').append(str(t.getValue()));
                        ft = false;
                    }
                    sb.append('}');
                }
                sb.append('}');
            }
        });
        return sb.append("]}").toString();
    }

    private static String str(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    // ---------------------------------------------------------------- служебное

    private static DataSet editDataSet() throws HttpError {
        DataSet ds = MainApplication.getLayerManager().getEditDataSet();
        if (ds == null) throw new HttpError(409, "no active OSM data layer in JOSM");
        return ds;
    }

    private static void readLocked(DataSet ds, Runnable r) {
        ds.getReadLock().lock();
        try {
            r.run();
        } finally {
            ds.getReadLock().unlock();
        }
    }

    private static void onEdt(Runnable r) throws Exception {
        if (SwingUtilities.isEventDispatchThread()) r.run();
        else SwingUtilities.invokeAndWait(r);
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null) return out;
        for (String kv : raw.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0) out.put(URLDecoder.decode(kv.substring(0, i), StandardCharsets.UTF_8), URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8));
        }
        return out;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        return in.readAllBytes();
    }

    /**
     * Страница редактора с его сайта (simple3d.url) под адресом плагина: со страницы по https Safari не пускает
     * запросы к http://127.0.0.1, а страница с того же http-адреса, что и плагин, работает в любом браузере.
     * Сборка редактора с base './' — пути относительные, подпапка /editor/ ей подходит.
     */
    private static void proxyEditor(Exchange ex, String rest) throws IOException {
        String base = Simple3DPlugin.EDITOR_URL.get();
        if (!base.endsWith("/")) base += "/";
        String query = ex.getRequestURI().getRawQuery();
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) java.net.URI.create(base + rest + (query != null ? "?" + query : "")).toURL().openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        int status = c.getResponseCode();
        byte[] body;
        try (InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream()) {
            body = in == null ? new byte[0] : in.readAllBytes();
        }
        // Ошибку сайта не кешировать: иначе браузер покажет её и после того, как сайт ожил
        if (status >= 400) ex.getResponseHeaders().add("Cache-Control", "no-store");
        for (String h : status >= 400 ? new String[] {"Content-Type"} : new String[] {"Content-Type", "Cache-Control", "Last-Modified", "ETag"}) {
            String v = c.getHeaderField(h);
            if (v != null) ex.getResponseHeaders().add(h, v);
        }
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
    }

    private static void send(Exchange ex, int status, String type, String body) throws IOException {
        if (body == null) {
            ex.sendResponseHeaders(status, -1);
            return;
        }
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        if (type != null) ex.getResponseHeaders().add("Content-Type", type);
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    static class HttpError extends Exception {
        final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
