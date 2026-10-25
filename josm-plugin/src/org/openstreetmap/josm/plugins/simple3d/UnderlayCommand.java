package org.openstreetmap.josm.plugins.simple3d;

import java.util.Collection;
import java.util.Collections;

import org.openstreetmap.josm.command.Command;
import org.openstreetmap.josm.data.osm.DataSet;
import org.openstreetmap.josm.data.osm.OsmPrimitive;

/**
 * Шаг правки подложки редактора (своей картинки — она хранится в браузере, не в данных JOSM) в истории JOSM: данные
 * не меняет, только сообщает редактору об отмене и повторе — так подложки и правки данных отменяются одним Ctrl+Z
 * в общем порядке. Первое выполнение (при добавлении) — молча: в редакторе шаг уже сделан.
 */
class UnderlayCommand extends Command {
    interface Listener {
        void underlay(String id, boolean redo);
    }

    private final String id;
    private final String name;
    private final Listener listener;
    private boolean done;

    UnderlayCommand(DataSet ds, String id, String name, Listener listener) {
        super(ds);
        this.id = id;
        this.name = name;
        this.listener = listener;
    }

    @Override
    public boolean executeCommand() {
        if (done) listener.underlay(id, true);
        done = true;
        return true;
    }

    @Override
    public void undoCommand() {
        listener.underlay(id, false);
    }

    @Override
    public void fillModifiedData(Collection<OsmPrimitive> modified, Collection<OsmPrimitive> deleted, Collection<OsmPrimitive> added) {
        // Данные не меняются
    }

    @Override
    public Collection<? extends OsmPrimitive> getParticipatingPrimitives() {
        return Collections.emptyList();
    }

    @Override
    public String getDescriptionText() {
        return name;
    }
}
