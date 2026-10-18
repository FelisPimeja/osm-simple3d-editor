package org.openstreetmap.josm.plugins.simple3d;

import java.awt.GraphicsConfiguration;
import java.awt.Rectangle;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

import org.openstreetmap.josm.data.preferences.StringProperty;
import org.openstreetmap.josm.gui.MainApplication;
import org.openstreetmap.josm.spi.preferences.Config;
import org.openstreetmap.josm.tools.Logging;
import org.openstreetmap.josm.tools.OpenBrowser;
import org.openstreetmap.josm.tools.PlatformManager;

/**
 * Редактор окном-приложением: Chromium-браузер с --app — окно без вкладок и адресной строки, справа на экране JOSM.
 * Свой профиль браузера (в кеше JOSM): окно открывается новым процессом, и размер с положением соблюдаются;
 * вкладки и расширения обычного профиля не мешают. Нет Chromium-браузера — обычный браузер по умолчанию.
 */
final class AppWindow {
    /** app — окно-приложение (по умолчанию), default — браузер по умолчанию, иначе — путь к исполняемому файлу Chromium-браузера. */
    static final StringProperty BROWSER = new StringProperty("simple3d.browser", "app");

    private AppWindow() {
    }

    static void open(String url) {
        String mode = BROWSER.get();
        String exe = "default".equals(mode) ? null : "app".equals(mode) ? findChromium() : mode;
        if (exe != null) {
            try {
                launch(exe, url);
                return;
            } catch (Exception e) {
                Logging.warn("Simple3D: не удалось открыть окно-приложение (" + exe + "): " + e);
            }
        }
        OpenBrowser.displayUrl(url);
    }

    private static void launch(String exe, String url) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add(exe);
        cmd.add("--app=" + url);
        cmd.add("--user-data-dir=" + new File(Config.getDirs().getCacheDirectory(true), "simple3d-browser").getAbsolutePath());
        cmd.add("--no-first-run");
        cmd.add("--no-default-browser-check");
        Rectangle r = targetBounds();
        if (r != null) {
            cmd.add("--window-position=" + r.x + "," + r.y);
            cmd.add("--window-size=" + r.width + "," + r.height);
        }
        new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
    }

    /** Правая половина экрана, на котором окно JOSM (карту JOSM можно оставить слева). */
    private static Rectangle targetBounds() {
        if (MainApplication.getMainFrame() == null) return null;
        GraphicsConfiguration gc = MainApplication.getMainFrame().getGraphicsConfiguration();
        if (gc == null) return null;
        Rectangle s = gc.getBounds();
        return new Rectangle(s.x + s.width / 2, s.y, s.width - s.width / 2, s.height);
    }

    /** Первый найденный Chromium-браузер (Chrome, Edge, Chromium, Brave, Vivaldi) или null. */
    static String findChromium() {
        List<String> candidates = new ArrayList<>();
        String home = System.getProperty("user.home");
        if (PlatformManager.isPlatformOsx()) {
            String[][] apps = {{"Google Chrome", "Google Chrome"}, {"Microsoft Edge", "Microsoft Edge"}, {"Chromium", "Chromium"},
                {"Brave Browser", "Brave Browser"}, {"Vivaldi", "Vivaldi"}};
            for (String root : new String[] {"/Applications", home + "/Applications"}) {
                for (String[] a : apps) candidates.add(root + "/" + a[0] + ".app/Contents/MacOS/" + a[1]);
            }
        } else if (PlatformManager.isPlatformWindows()) {
            String[] roots = {System.getenv("ProgramFiles"), System.getenv("ProgramFiles(x86)"), System.getenv("LOCALAPPDATA")};
            String[] exes = {"Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe",
                "Chromium\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe", "Vivaldi\\Application\\vivaldi.exe"};
            for (String exe : exes) for (String root : roots) if (root != null) candidates.add(root + "\\" + exe);
        } else {
            String path = System.getenv("PATH");
            String[] names = {"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser", "vivaldi"};
            for (String name : names) {
                for (String dir : path == null ? new String[0] : path.split(File.pathSeparator)) candidates.add(dir + "/" + name);
            }
        }
        for (String c : candidates) if (new File(c).canExecute()) return c;
        return null;
    }
}
