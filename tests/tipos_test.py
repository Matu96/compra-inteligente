"""python tests/tipos_test.py — casos reales de SEPA que tienen que agruparse bien."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
from sepa_import import tipo_de

CASOS = [  # (descripción, marca, presentación informada, producto genérico esperado)
    ("YERBA MATE 4 FLEX TARAGUI PAQ 1 KGM", "TARAGUI", "1 kgm", "Yerba mate 1 kg"),
    ("Yerba mate Cuisine & Co 1 kg PAQ-1000-gr.", "CUISINE & CO", "1 gr", "Yerba mate 1 kg"),
    ("Yerba mate Cuisine & Co 0,5 kg PAQ-500-gr.", "CUISINE & CO", "0.5 gr", "Yerba mate 500 g"),
    ("YERBA MATE 4 FLEX SIN PALO TARAGUI PAQ 1 KGM", "TARAGUI", "1 kgm", "Yerba mate sin palo 1 kg"),
    ("Yerba Mate 4 Flex Sin Pal Taragui Paq 1 Kgm", "TARAGUI", "1 kgm", "Yerba mate sin palo 1 kg"),
    ("Yerba mate Taragui 4Flex Sin Palo 500G LAM", "TARAGUI", "500 gr", "Yerba mate sin palo 500 g"),
    ("YERBA MATE C PALO ORIG CROL TARAGUI 4FLEX 1 KG", "TARAGUI", "1 UNI", "Yerba mate 1 kg"),
    ("YERBA MATE S/PALO ROSAMONTE 1 KG", "ROSAMONTE", "1 kg", "Yerba mate sin palo 1 kg"),
    ("YERBA MATE DESPALADA CBSE 500 G", "CBSE", "500 gr", "Yerba mate sin palo 500 g"),
    ("Yerba Mate Canarias Serena 1 Kg", "CANARIAS", "1 kg", "Yerba mate suave 1 kg"),
    ("YERBA PLAYADITO SUAVE 1 KG", "PLAYADITO", "1 kg", "Yerba mate suave 1 kg"),
    ("YERBA MATE ROSAMONTE BARBACUA 1 KG", "ROSAMONTE", "1 kg", "Yerba mate barbacuá 1 kg"),
    ("YERBA MATE ORGANICA ROMANCE 500 G", "ROMANCE", "500 gr", "Yerba mate orgánica 500 g"),
    ("Leche Entera La Serenisima 1 Lt", "LA SERENISIMA", "1 lt", "Leche entera 1 L"),
    ("CAFE MOLIDO CARREFOUR BOLSA X 250 GRS", "CARREFOUR", "250 gr", "Café molido 250 g"),
    ("CAFE INST SUAVE MORE DP", "MORE", "170 gr", "Café instantáneo 170 g"),
    ("CAFE TORR.SUAVE SENSACION", "SENSACION", "500 gr", "Café torrado 500 g"),
    ("DURAZNO EN MITADES", "DIA", "820 gr", "Duraznos en almíbar 820 g"),
    ("DURAZNOS EN MITADES CARREFOUR LATA X 820 GRS", "CARREFOUR", "820 gr", "Duraznos en almíbar 820 g"),
    ("DURAZNO EN MITADES COPA DE ORO LAT 820 G", "COPA DE ORO", "820 grm", "Duraznos en almíbar 820 g"),
    ("DURAZNOS COTO BAJAS CALORIAS LAT 800 GRM", "COTO", "800 grm", "Duraznos en almíbar light 800 g"),
    ("ARVEJAS CIUDAD DEL LAGO LAT 300 GRM", "CIUDAD DEL LAGO", "300 grm", "Arvejas 300 g"),
    ("Arroz Parboil CUISINE & CO 1Kg PAQ-1000-gr.", "CUISINE & CO", "1 gr", "Arroz parboil 1 kg"),
]
NO_MEZCLAR = [  # no tienen que caer en estos genéricos
    ("MERMELADA D/DURAZNO LIGHT CAROYENSE FRA", "CAROYENSE", "390 gr", "Duraznos en almíbar"),
    ("DURAZNO DESHID.E/MITADES FRUIT LIFE POT", "FRUIT LIFE", "250 gr", "Duraznos en almíbar"),
    ("JUGO DURAZNO EN POLVO", "TANG", "18 gr", "Duraznos en almíbar"),
]
mal = 0
for d, m, p, esperado in CASOS:
    got = tipo_de(d, m, p)[1]
    if got != esperado:
        mal += 1; print(f"✗ {d!r} → {got!r} (esperado {esperado!r})")
for d, m, p, prohibido in NO_MEZCLAR:
    got = tipo_de(d, m, p)[1]
    if got.startswith(prohibido):
        mal += 1; print(f"✗ {d!r} → {got!r} (no debería ser {prohibido!r})")
if mal:
    sys.exit(f"{mal} casos fallaron")
print(f"✔ agrupación: {len(CASOS) + len(NO_MEZCLAR)} casos OK")
