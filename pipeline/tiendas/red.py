"""red.py — cliente HTTP asíncrono con límite de pedidos por segundo y reintentos con backoff exponencial."""
import asyncio
import json
import random
import time

import aiohttp

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")


class Limite:
    """Token bucket: como mucho `rps` pedidos por segundo (por tienda)."""

    def __init__(self, rps):
        self.intervalo = 1 / rps
        self.proximo = 0.0
        self.lock = asyncio.Lock()

    async def esperar(self):
        async with self.lock:
            ahora = time.monotonic()
            espera = self.proximo - ahora
            self.proximo = max(ahora, self.proximo) + self.intervalo
        if espera > 0:
            await asyncio.sleep(espera)


class Cliente:
    def __init__(self, rps=4, concurrencia=6, intentos=6, timeout=40, headers=None, cookies=None):
        self.limite = Limite(rps)
        self.sem = asyncio.Semaphore(concurrencia)
        self.intentos = intentos
        h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "es-AR,es;q=0.9"}
        h.update(headers or {})
        self.sesion = aiohttp.ClientSession(headers=h, cookies=cookies, timeout=aiohttp.ClientTimeout(total=timeout),
                                            connector=aiohttp.TCPConnector(limit=concurrencia * 2, ttl_dns_cache=300))
        self.pedidos = 0
        self.errores = 0

    async def get(self, url, params=None, como="json"):
        """Devuelve (datos, headers). Reintenta 429/5xx/cortes con backoff exponencial + jitter."""
        ultimo = None
        for intento in range(self.intentos):
            await self.limite.esperar()
            try:
                async with self.sem, self.sesion.get(url, params=params) as r:
                    self.pedidos += 1
                    if r.status in (429, 500, 502, 503, 504, 520, 522, 524):
                        ra = r.headers.get("Retry-After")
                        espera = float(ra) if ra and ra.isdigit() else None
                        raise _Reintentar(f"HTTP {r.status}", espera)
                    if r.status == 404:
                        return None, r.headers
                    if r.status >= 400:
                        raise PermissionError(f"HTTP {r.status} en {r.url}")
                    texto = await r.text()
                    if como == "texto":
                        return texto, r.headers
                    try:
                        return json.loads(texto), r.headers
                    except json.JSONDecodeError:
                        raise _Reintentar("respuesta que no es JSON", None) if intento < 2 else ValueError(
                            f"No es JSON ({texto[:120]!r}) en {r.url}")
            except PermissionError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, _Reintentar) as e:
                ultimo = e
                self.errores += 1
                espera = getattr(e, "espera", None) or min(60, 1.5 * 2 ** intento) + random.random()
                await asyncio.sleep(espera)
        raise RuntimeError(f"Sin respuesta tras {self.intentos} intentos ({ultimo}): {url} {params or ''}")

    async def cerrar(self):
        await self.sesion.close()


class _Reintentar(Exception):
    def __init__(self, msg, espera):
        super().__init__(msg)
        self.espera = espera
