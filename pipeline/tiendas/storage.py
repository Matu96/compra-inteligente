"""storage.py — guardado incremental en SQLite (con reanudación) y exportación a JSON.

Tabla productos: clave única (tienda, sku_tienda) → deduplica solo. Tabla tareas: qué categorías/páginas
ya se terminaron, para que una corrida cortada siga desde donde quedó (main.py --reiniciar la limpia).
"""
import json
import sqlite3
import threading
from datetime import datetime, timezone

CAMPOS = ["tienda", "ean", "sku_tienda", "nombre", "marca", "precio_lista", "precio_final", "descuento_porcentaje",
          "promociones", "image_url", "product_url", "fecha_extraccion"]


def ahora():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Almacen:
    def __init__(self, ruta):
        self.db = sqlite3.connect(ruta, check_same_thread=False)
        self.lock = threading.Lock()
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS productos (
                tienda TEXT NOT NULL, ean TEXT, sku_tienda TEXT NOT NULL, nombre TEXT, marca TEXT,
                precio_lista REAL, precio_final REAL, descuento_porcentaje INTEGER, promociones TEXT,
                image_url TEXT, product_url TEXT, fecha_extraccion TEXT,
                PRIMARY KEY (tienda, sku_tienda));
            CREATE INDEX IF NOT EXISTS productos_ean ON productos(ean);
            CREATE TABLE IF NOT EXISTS tareas (tienda TEXT, clave TEXT, fecha TEXT, PRIMARY KEY (tienda, clave));
        """)

    # ------------------------------------------------------------ productos
    def guardar(self, filas):
        """Inserta o actualiza (upsert) una tanda de productos y confirma enseguida (guardado incremental)."""
        if not filas:
            return 0
        datos = [tuple(json.dumps(f[c], ensure_ascii=False) if c == "promociones" else f[c] for c in CAMPOS) for f in filas]
        with self.lock:
            self.db.executemany(f"""INSERT INTO productos ({','.join(CAMPOS)}) VALUES ({','.join('?' * len(CAMPOS))})
                ON CONFLICT(tienda, sku_tienda) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in CAMPOS[1:])}""", datos)
            self.db.commit()
        return len(datos)

    def contar(self, tienda=None):
        q, a = "SELECT COUNT(*) FROM productos", ()
        if tienda:
            q, a = q + " WHERE tienda=?", (tienda,)
        return self.db.execute(q, a).fetchone()[0]

    def productos(self, tienda=None):
        q, a = f"SELECT {','.join(CAMPOS)} FROM productos", ()
        if tienda:
            q, a = q + " WHERE tienda=?", (tienda,)
        for fila in self.db.execute(q + " ORDER BY tienda, sku_tienda", a):
            d = dict(zip(CAMPOS, fila))
            d["promociones"] = json.loads(d["promociones"] or "[]")
            yield d

    def borrar_viejos(self, tienda, desde):
        """Saca los productos de la tienda que no aparecieron en esta corrida (se dieron de baja o sin stock)."""
        with self.lock:
            n = self.db.execute("DELETE FROM productos WHERE tienda=? AND fecha_extraccion < ?", (tienda, desde)).rowcount
            self.db.commit()
        return n

    # ------------------------------------------------------------ reanudación
    def hecha(self, tienda, clave):
        return self.db.execute("SELECT 1 FROM tareas WHERE tienda=? AND clave=?", (tienda, clave)).fetchone() is not None

    def marcar(self, tienda, clave):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO tareas VALUES (?,?,?)", (tienda, clave, ahora()))
            self.db.commit()

    def reiniciar(self, tienda):
        with self.lock:
            self.db.execute("DELETE FROM tareas WHERE tienda=?", (tienda,))
            self.db.commit()

    # ------------------------------------------------------------ exportación
    def exportar_json(self, ruta, tienda=None):
        """JSON con una lista de productos, escrito en streaming (no carga todo en memoria)."""
        n = 0
        with open(ruta, "w", encoding="utf-8") as f:
            f.write("[\n")
            for p in self.productos(tienda):
                f.write((",\n" if n else "") + json.dumps(p, ensure_ascii=False))
                n += 1
            f.write("\n]\n")
        return n

    def cerrar(self):
        self.db.close()
