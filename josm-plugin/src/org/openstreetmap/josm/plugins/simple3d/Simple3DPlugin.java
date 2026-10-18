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

    private final BridgeServer server;

    public Simple3DPlugin(PluginInformation info) {
        super(info);
        server = new BridgeServer(PORT.get());
        try {
            server.start();
        } catch (Exception e) {
            Logging.error("Simple3D: не удалось открыть порт " + PORT.get() + ": " + e);
        }
        MainMenu.add(MainApplication.getMenu().viewMenu, new OpenEditorAction());
    }

    /** Открыть 3D-редактор в браузере над текущим видом карты. */
    static class OpenEditorAction extends JosmAction {
        OpenEditorAction() {
            super(tr("Open in 3D editor (Simple3D)"), (String) null, tr("Open the active layer in the Simple 3D Buildings editor"),
                Shortcut.registerShortcut("view:simple3d", tr("View: {0}", tr("Open in 3D editor (Simple3D)")),
                    KeyEvent.VK_3, Shortcut.ALT_CTRL_SHIFT), false);
        }

        @Override
        public void actionPerformed(ActionEvent e) {
            // Через плагин (http://127.0.0.1) — иначе Safari со страницы по https не достучится до плагина
            String page = PROXY.get() ? "http://127.0.0.1:" + PORT.get() + "/editor/" : EDITOR_URL.get();
            String url = page + (page.contains("?") ? "&" : "?") + "source=josm";
            // Сервер JOSM — редактору для подложки и ссылок (?server= как в адресе редактора)
            String api = org.openstreetmap.josm.io.OsmApi.getOsmApi().getBaseUrl();
            if (api.contains("opengeofiction")) url += "&server=ogf";
            else if (api.contains("openhistoricalmap")) url += "&server=ohm";
            else if (api.contains("openstreetmap.org")) url += "&server=osm";
            MapView mv = MainApplication.isDisplayingMapView() ? MainApplication.getMap().mapView : null;
            if (mv != null) {
                LatLon c = mv.getProjection().eastNorth2latlon(mv.getCenter());
                double zoom = Math.max(16, Math.min(20, Math.log(156543.03 * Math.cos(Math.toRadians(c.lat())) / mv.getDist100Pixel() * 100) / Math.log(2)));
                url += String.format(Locale.ROOT, "#%.2f/%.6f/%.6f", zoom, c.lat(), c.lon());
            }
            AppWindow.open(url);
        }
    }
}
