package org.openstreetmap.josm.plugins.simple3d;

import static org.openstreetmap.josm.tools.I18n.tr;

import java.awt.event.ActionEvent;
import java.awt.event.KeyEvent;
import java.util.Locale;

import org.openstreetmap.josm.actions.JosmAction;
import org.openstreetmap.josm.data.coor.LatLon;
import org.openstreetmap.josm.data.preferences.IntegerProperty;
import org.openstreetmap.josm.data.preferences.StringProperty;
import org.openstreetmap.josm.gui.MainApplication;
import org.openstreetmap.josm.gui.MainMenu;
import org.openstreetmap.josm.gui.MapView;
import org.openstreetmap.josm.plugins.Plugin;
import org.openstreetmap.josm.plugins.PluginInformation;
import org.openstreetmap.josm.tools.Logging;
import org.openstreetmap.josm.tools.Shortcut;

/**
 * Связь с 3D-редактором: локальный HTTP-сервер (127.0.0.1, порт simple3d.port, по умолчанию 8112) отдаёт
 * активный слой и принимает правки редактора в виде osmChange — они становятся командами JOSM (Ctrl+Z).
 */
public class Simple3DPlugin extends Plugin {
    static final IntegerProperty PORT = new IntegerProperty("simple3d.port", 8112);
    /** Открывать редактор через плагин (http://127.0.0.1:порт/editor/), а не прямо с его сайта. */
    static final org.openstreetmap.josm.data.preferences.BooleanProperty PROXY = new org.openstreetmap.josm.data.preferences.BooleanProperty("simple3d.proxy", true);
    /** Ещё сайты (origin через запятую), которым можно обращаться к плагину, — кроме сайта редактора и localhost. */
    static final StringProperty ORIGINS = new StringProperty("simple3d.origins", "");
    static final StringProperty EDITOR_URL = new StringProperty("simple3d.url", "https://felispimeja.github.io/osm-simple3d-editor/");

    /** Сколько портов подряд пробовать, если основной занят (Windows резервирует диапазоны под Hyper-V/WSL). */
    private static final int PORT_TRIES = 10;

    private final BridgeServer server;
    /** Сервер не запустился ни на одном порту: редактор открывается с сайта, без связи с JOSM. */
    private final boolean running;

    public Simple3DPlugin(PluginInformation info) {
        super(info);
        BridgeServer started = null;
        Exception last = null;
        for (int i = 0; i < PORT_TRIES && started == null; i++) {
            BridgeServer s = new BridgeServer(PORT.get() + i);
            try {
                s.start();
                started = s;
            } catch (Exception e) {
                last = e;
                Logging.warn("Simple3D: port " + (PORT.get() + i) + " is unavailable: " + e);
            }
        }
        running = started != null;
        server = running ? started : new BridgeServer(PORT.get());
        if (!running) Logging.error("Simple3D: could not open any port " + PORT.get() + "–" + (PORT.get() + PORT_TRIES - 1) + ": " + last);
        MainMenu.add(MainApplication.getMenu().viewMenu, new OpenEditorAction(server, running));
        org.openstreetmap.josm.actions.UploadAction.registerUploadHook(server.uploadHook());
    }

    /** Открыть 3D-редактор в браузере над текущим видом карты. */
    static class OpenEditorAction extends JosmAction {
        private final BridgeServer server;
        private final boolean running;

        OpenEditorAction(BridgeServer server, boolean running) {
            super(tr("Open in 3D editor (Simple3D)"), "simple3d", tr("Open the active layer in the Simple 3D Buildings editor"),
                Shortcut.registerShortcut("view:simple3d", tr("View: {0}", tr("Open in 3D editor (Simple3D)")),
                    KeyEvent.VK_3, Shortcut.ALT_CTRL_SHIFT), false);
            this.server = server;
            this.running = running;
        }

        @Override
        public void actionPerformed(ActionEvent e) {
            // Через плагин (http://127.0.0.1) — иначе Safari со страницы по https не достучится до плагина
            // Сервер плагина не запустился — страница с 127.0.0.1 не откроется: редактор с сайта и объяснение в JOSM
            if (!running) {
                new org.openstreetmap.josm.gui.Notification(tr("Simple3D could not open a local port ({0}–{1}), so the editor opens without a link to JOSM. "
                    + "Set another port in Preferences → Advanced (simple3d.port) and restart JOSM.", String.valueOf(PORT.get()), String.valueOf(PORT.get() + PORT_TRIES - 1)))
                    .setIcon(javax.swing.JOptionPane.WARNING_MESSAGE).setDuration(org.openstreetmap.josm.gui.Notification.TIME_LONG).show();
            }
            String page = running && PROXY.get() ? "http://127.0.0.1:" + server.port() + "/editor/" : EDITOR_URL.get();
            String url = page + (page.contains("?") ? "&" : "?") + "source=josm";
            // Сервер JOSM — редактору для подложки и ссылок (?server= как в адресе редактора)
            String api = org.openstreetmap.josm.io.OsmApi.getOsmApi().getBaseUrl();
            if (api.contains("opengeofiction")) url += "&server=ogf";
            else if (api.contains("openhistoricalmap")) url += "&server=ohm";
            else if (api.contains("openstreetmap.org")) url += "&server=osm";
            MapView mv = MainApplication.isDisplayingMapView() ? MainApplication.getMap().mapView : null;
            LatLon c = mv != null ? mv.getProjection().eastNorth2latlon(mv.getCenter()) : null;
            double zoom = c == null ? 0
                : Math.max(16, Math.min(20, Math.log(156543.03 * Math.cos(Math.toRadians(c.lat())) / mv.getDist100Pixel() * 100) / Math.log(2)));
            // Редактор уже открыт — второе окно не нужно: открытый переходит к виду JOSM
            if (server.editorOpen()) {
                if (c != null) server.goTo(c.lat(), c.lon(), zoom);
                new org.openstreetmap.josm.gui.Notification(tr("The 3D editor is already open — it now shows the current JOSM view."))
                    .setIcon(javax.swing.JOptionPane.INFORMATION_MESSAGE).show();
                return;
            }
            if (c != null) url += String.format(Locale.ROOT, "#%.2f/%.6f/%.6f", zoom, c.lat(), c.lon());
            AppWindow.open(url);
        }
    }
}
