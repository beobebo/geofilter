from flask import Flask, render_template, request, jsonify, Response, stream_with_context
import requests, math, json, time, os

app = Flask(__name__)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# Cache semplice in-memory per geocoding (riduce richieste ripetute mentre si digita)
_GEOCODE_CACHE = {}  # q -> {"ts": epoch, "data": {...}}
_GEOCODE_TTL_S = 300

# Carica il vocabolario dei luoghi da file JSON
def load_places_mapping():
    """Carica il mapping dei luoghi da locations.json"""
    try:
        json_path = os.path.join(os.path.dirname(__file__), 'locations.json')
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Appiattisci il dizionario annidato in un singolo mapping flat
        flat_mapping = {}
        for category, places in data.get('locations', {}).items():
            if isinstance(places, dict):
                for place_name, tags in places.items():
                    if place_name != "comment":
                        # Converte da lista di liste a lista di tuple
                        flat_mapping[place_name.lower()] = [tuple(tag) for tag in tags]
        
        return flat_mapping
    except Exception as e:
        print(f"Errore nel caricamento di locations.json: {e}")
        return {}

PLACE_MAPPING = load_places_mapping()

def resolve_place(place_name, mode='list'):
    """
    Risolve il nome di un luogo nel relativo tag OSM.
    Ritorna una lista di tuple (key, value) da usare nella query Overpass.
    
    Se mode='list': usa il PLACE_MAPPING
    Se mode='manual': parsa direttamente il tag (es "amenity=pharmacy")
    """
    if mode == 'manual':
        # Parsa il tag manuale nel formato "key=value" oppure "key=value|key2=value2"
        tags = []
        for part in place_name.split('|'):
            part = part.strip()
            if '=' in part:
                key, value = part.split('=', 1)
                tags.append((key.strip(), value.strip()))
        return tags if tags else [(place_name.replace(" ", "_"),)]
    
    # Modalità list: usa il mapping
    place_lower = place_name.lower().strip()
    
    # Ricerca diretta
    if place_lower in PLACE_MAPPING:
        return PLACE_MAPPING[place_lower]
    
    # Ricerca per substring (es. "farmacie" potrebbe trovare "farmacia")
    for key, tags in PLACE_MAPPING.items():
        if place_lower in key or key in place_lower:
            return tags
    
    # Se non trova nulla, restituisce come tag generico
    return [(place_lower.replace(" ", "_"),)]

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def geocode_bbox(place):
    params = {"q": place, "format": "json", "limit": 1}
    headers = {"User-Agent": "geo-filter-app"}
    try:
        r = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=15)
        r.raise_for_status()
        items = r.json()
        if not items:
            return None
        bb = items[0]["boundingbox"]
        # Nominatim ritorna [minLat, maxLat, minLon, maxLon]
        return f"{float(bb[0])},{float(bb[2])},{float(bb[1])},{float(bb[3])}"
    except Exception as e:
        print(f"Errore Geocoding: {e}")
        return None

def geocode_place(place):
    """
    Geocoding via Nominatim. Ritorna dict con lat/lon, bbox, display_name.
    Usa una cache in-memory con TTL.
    """
    q = (place or "").strip()
    if not q:
        return None

    now = time.time()
    cached = _GEOCODE_CACHE.get(q.lower())
    if cached and (now - cached.get("ts", 0)) < _GEOCODE_TTL_S:
        return cached.get("data")

    params = {"q": q, "format": "json", "limit": 1}
    headers = {"User-Agent": "geo-filter-app"}
    try:
        r = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=15)
        r.raise_for_status()
        items = r.json()
        if not items:
            return None
        it = items[0]
        bb = it.get("boundingbox")
        data = {
            "lat": float(it["lat"]),
            "lon": float(it["lon"]),
            "bbox": bb,
            "name": it.get("display_name", q),
        }
        _GEOCODE_CACHE[q.lower()] = {"ts": now, "data": data}
        return data
    except Exception as e:
        print(f"Errore Geocoding (place): {e}")
        return None

def fetch_osm_points(tags_list, bbox):
    """
    Scarica punti OSM dato una lista di tag.
    tags_list: lista di tuple (key, value)
    bbox: stringa "minLat,minLon,maxLat,maxLon"
    """
    # Costruisci query Overpass dinamica
    selectors = []
    for key, value in tags_list:
        key = str(key).replace('\\', '\\\\').replace('"', '\\"')
        value = str(value).replace('\\', '\\\\').replace('"', '\\"')
        selectors.append(f'node["{key}"="{value}"]({bbox});')
        selectors.append(f'way["{key}"="{value}"]({bbox});')
    
    query = f"""
    [out:json][timeout:30];
    (
      {' '.join(selectors)}
    );
    out center;
    """
    
    # Retry logic con exponential backoff per timeout/504
    max_retries = 3
    base_delay = 1
    
    for attempt in range(max_retries):
        try:
            r = requests.post(OVERPASS_URL, data=query, timeout=40)
            
            # Se successo, elabora i risultati
            if r.status_code == 200:
                data = r.json()
                points = []
                for el in data.get("elements", []):
                    lat, lon = None, None
                    if el.get("type") == "node":
                        lat, lon = el.get("lat"), el.get("lon")
                    elif el.get("center"):
                        lat, lon = el.get("center", {}).get("lat"), el.get("center", {}).get("lon")
                    
                    if lat and lon:
                        # Estrai nome se disponibile nei tags
                        tags = el.get("tags", {})
                        name = tags.get("name", "Senza nome")
                        
                        points.append({
                            "lat": float(lat),
                            "lon": float(lon),
                            "name": name
                        })
                return points
            
            # Se 504 o timeout (429, 503), ritenta
            elif r.status_code in [429, 504, 503]:
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)
                    print(f"Overpass status {r.status_code}, ritentativo {attempt + 1}/{max_retries} dopo {delay}s...")
                    time.sleep(delay)
                    continue
                else:
                    print(f"Overpass error {r.status_code} dopo {max_retries} tentativi")
                    return []
            else:
                print(f"Overpass error: {r.status_code}")
                return []
                
        except requests.exceptions.Timeout:
            if attempt < max_retries - 1:
                delay = base_delay * (2 ** attempt)
                print(f"Overpass timeout, ritentativo {attempt + 1}/{max_retries} dopo {delay}s...")
                time.sleep(delay)
            else:
                print(f"Overpass timeout dopo {max_retries} tentativi")
                return []
        except Exception as e:
            print(f"Errore Overpass: {e}")
            return []
    
    return []

def fetch_osm_points_retry_zero(tags_list, bbox, retries=1, delay_s=1.0):
    """
    Come fetch_osm_points, ma se ottiene 0 risultati ritenta (utile contro risultati
    intermittenti da Overpass che talvolta tornano vuoti).
    """
    pts = fetch_osm_points(tags_list, bbox)
    attempt = 0
    while attempt < retries and len(pts) == 0:
        attempt += 1
        try:
            time.sleep(delay_s)
        except Exception:
            pass
        pts = fetch_osm_points(tags_list, bbox)
    return pts

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/geocode")
def geocode_api():
    """Endpoint leggero per preview raggio lato frontend."""
    q = request.args.get("q", "").strip()
    data = geocode_place(q)
    if not data:
        return jsonify({"status": "error", "message": "not found"}), 404
    return jsonify({
        "status": "success",
        "lat": data["lat"],
        "lon": data["lon"],
        "bbox": data.get("bbox"),
        "name": data.get("name"),
    })

@app.route("/get_categories")
def get_categories():
    """Restituisce l'elenco di tutte le categorie disponibili (esclusi i BRAND)"""
    try:
        json_path = os.path.join(os.path.dirname(__file__), 'locations.json')
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Raccogli tutte le categorie (escludendo i brand)
        categories = []
        for group, places in data.get('locations', {}).items():
            if isinstance(places, dict):
                for place_name, tags in places.items():
                    if place_name != "comment":
                        # Escludiamo voci che contengono solo tag "brand"
                        # (se tutti i tag sono brand, lo escludiamo)
                        has_non_brand = any(tag[0] != "brand" for tag in tags if isinstance(tag, list))
                        if has_non_brand or not any(tag[0] == "brand" for tag in tags if isinstance(tag, list)):
                            categories.append(place_name)
        
        # Ordina alfabeticamente
        categories.sort()

        # Opzioni speciali in cima (richiesta UI)
        special = ["Aggiungi brand", "Tag OSM personalizzato"]
        categories = special + ["---"] + categories
        
        return jsonify({
            "status": "success",
            "categories": categories,
            "count": len(categories)
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

@app.route("/search_stream")
def search_stream():
    """
    Gestisce ricerca di categorie.
    Modalità 1 (legacy): Coppie indipendenti
    Modalità 2 (nuova): Catena di categorie collegate
    """
    city = request.args.get('city', '').strip()
    try:
        search_radius = float(request.args.get('search_radius', 50000))
    except:
        search_radius = 50000.0
    
    # Rileva modalità
    is_chain_mode = request.args.get('chain_mode', 'false').lower() == 'true'
    
    if is_chain_mode:
        # Modalità catena di categorie
        try:
            chain_length = int(request.args.get('chain_length', 0))
        except:
            chain_length = 0
        
        chain_definitions = []
        for i in range(chain_length):
            cat_name = request.args.get(f'chain_{i}_name', '').strip()
            cat_mode = request.args.get(f'chain_{i}_mode', 'list').strip()
            
            if cat_name:
                chain_definitions.append({
                    'name': cat_name,
                    'mode': cat_mode
                })
        
        # Leggi i link tra categorie (arbitrari, non solo consecutivi)
        links = {}  # links[(from_idx, to_idx)] = {'min_dist': X, 'max_dist': Y}
        link_idx = 0
        while True:
            from_idx_str = request.args.get(f'link_{link_idx}_from')
            if from_idx_str is None:
                break
            try:
                from_idx = int(from_idx_str)
                to_idx = int(request.args.get(f'link_{link_idx}_to', 0))
                mode = request.args.get(f'link_{link_idx}_mode', 'range').strip()
                
                # Converti modalità in min/max
                if mode == 'nearest':
                    # Vicino: solo max_dist
                    min_dist = 0
                    max_dist = float(request.args.get(f'link_{link_idx}_value', 500))
                elif mode == 'farthest':
                    # Lontano: solo min_dist
                    min_dist = float(request.args.get(f'link_{link_idx}_value', 500))
                    max_dist = 999999999.0  # Infinito
                else:  # mode == 'range'
                    # Avanzata: min e max
                    min_dist = float(request.args.get(f'link_{link_idx}_min', 0))
                    max_dist = float(request.args.get(f'link_{link_idx}_max', 1000))
                
                links[(from_idx, to_idx)] = {
                    'min_dist': min_dist,
                    'max_dist': max_dist,
                    'mode': mode
                }
            except:
                pass
            link_idx += 1
        
        return search_chain(city, search_radius, chain_definitions, links)
    else:
        # Modalità coppie (legacy)
        try:
            pairs_count = int(request.args.get('pairs_count', 0))
        except:
            pairs_count = 0

        # Leggi le coppie da ricerca
        pair_definitions = []
        for i in range(pairs_count):
            cat1 = request.args.get(f'pair_{i}_cat1', '').strip()
            cat2 = request.args.get(f'pair_{i}_cat2', '').strip()
            mode1 = request.args.get(f'pair_{i}_mode1', 'list').strip()
            mode2 = request.args.get(f'pair_{i}_mode2', 'list').strip()
            try:
                distance = float(request.args.get(f'pair_{i}_distance', 500))
            except:
                distance = 500.0
            
            if cat1 and cat2:
                pair_definitions.append({
                    'cat1': cat1,
                    'cat2': cat2,
                    'mode1': mode1,
                    'mode2': mode2,
                    'max_distance': distance
                })

        return search_pairs(city, search_radius, pair_definitions)

def emit(obj):
    return f"data: {json.dumps(obj)}\n\n"

def _point_key(pt):
    try:
        return f"{float(pt['lat']):.7f}_{float(pt['lon']):.7f}"
    except Exception:
        return None

def _min_distance_to_points(from_pt, to_points, fail_if_below=None, succeed_if_below=None):
    """
    Ritorna la distanza minima tra from_pt e qualunque punto in to_points.
    - fail_if_below: se troviamo una distanza < questo valore, possiamo fallire subito.
    - succeed_if_below: se troviamo una distanza <= questo valore, possiamo avere successo subito (per vincoli 'vicino').
    """
    if not to_points:
        return float('inf')
    best = float('inf')
    for p in to_points:
        d = haversine(from_pt['lat'], from_pt['lon'], p['lat'], p['lon'])
        if d < best:
            best = d
            if fail_if_below is not None and best < fail_if_below:
                return best
            if succeed_if_below is not None and best <= succeed_if_below:
                return best
    return best

def _check_link_nearest_distance(from_pt, to_points, link):
    """
    Interpreta i vincoli come distanza dal PUNTO PIÙ VICINO della categoria di destinazione.
    - nearest: minDist(from,to) <= max
    - farthest: minDist(from,to) >= min
    - range: min <= minDist(from,to) <= max
    """
    mode = (link or {}).get('mode', 'range')
    min_d = float((link or {}).get('min_dist', 0))
    max_d = float((link or {}).get('max_dist', 999999999.0))

    if not to_points:
        return False

    if mode == 'nearest':
        dmin = _min_distance_to_points(from_pt, to_points, succeed_if_below=max_d)
        return dmin <= max_d
    if mode == 'farthest':
        dmin = _min_distance_to_points(from_pt, to_points, fail_if_below=min_d)
        return dmin >= min_d

    # range
    dmin = _min_distance_to_points(from_pt, to_points, fail_if_below=min_d, succeed_if_below=max_d)
    return (min_d <= dmin <= max_d)

def _incoming_links_for(idx, links, assignment):
    """Link del tipo (from -> idx) dove from è già assegnato."""
    incoming = []
    for (from_idx, to_idx), link in links.items():
        if to_idx == idx and from_idx in assignment:
            incoming.append((from_idx, link))
    incoming.sort(key=lambda x: x[0])
    return incoming

def _outgoing_links_to_assigned(idx, links, assignment):
    """Link del tipo (idx -> to) dove to è già assegnato."""
    outgoing = []
    for (from_idx, to_idx), link in links.items():
        if from_idx == idx and to_idx in assignment:
            outgoing.append((to_idx, link))
    outgoing.sort(key=lambda x: x[0])
    return outgoing

def _k_nearest_points(anchor_pt, points, k=40):
    """Ritorna fino a k punti più vicini ad anchor_pt (scan completo, k piccolo)."""
    if not anchor_pt or not points:
        return points[:k]
    best = []
    for p in points:
        d = haversine(anchor_pt['lat'], anchor_pt['lon'], p['lat'], p['lon'])
        best.append((d, p))
    best.sort(key=lambda x: x[0])
    return [p for _, p in best[:k]]

def _forward_check(all_points_full, points_limited, links, assignment, total_cats, max_points_scan=250):
    """
    Controllo di fattibilità: per ogni categoria non assegnata, deve esistere almeno
    un punto che renda possibile soddisfare i vincoli con le categorie già assegnate.
    """
    assigned_idxs = set(assignment.keys())
    for future_idx in range(total_cats):
        if future_idx in assigned_idxs:
            continue
        pts_full = all_points_full.get(future_idx, [])
        if not pts_full:
            return False

        # Vincoli da categorie già assegnate -> future_idx: non dipendono dal punto scelto in future_idx
        incoming = _incoming_links_for(future_idx, links, assignment)
        for from_idx, link in incoming:
            from_pt = assignment[from_idx]
            if not _check_link_nearest_distance(from_pt, pts_full, link):
                return False

        # Vincoli future_idx -> categorie già assegnate: deve esistere almeno un punto in future_idx che li soddisfi
        outgoing_to_assigned = _outgoing_links_to_assigned(future_idx, links, assignment)
        if outgoing_to_assigned:
            pts_scan = points_limited.get(future_idx, []) or pts_full
            ok_any = False
            for pt in pts_scan[:max_points_scan]:
                ok_pt = True
                for to_idx, link in outgoing_to_assigned:
                    to_pts = all_points_full.get(to_idx, [])
                    if not _check_link_nearest_distance(pt, to_pts, link):
                        ok_pt = False
                        break
                if ok_pt:
                    ok_any = True
                    break
            if not ok_any:
                return False

    return True

def build_independent_chains(all_points, chain_definitions, links, max_chains=100):
    """
    Costruisce catene indipendenti: per ogni punto della prima categoria tenta di
    trovare UNA sola catena completa rispettando TUTTI i vincoli.

    Nota: i vincoli sono calcolati rispetto al punto più vicino della categoria di destinazione
    (es. "almeno 1km da una chiesa" => distanza dalla chiesa più vicina >= 1km).
    """
    total = len(chain_definitions)
    if total == 0:
        return []

    all_points_full = all_points

    # Limita per prestazioni (solo per scelta candidati, NON per i calcoli di distanza minima)
    max_start_points = 80
    max_candidates_per_cat = 300

    points_limited = {
        idx: (pts[:max_candidates_per_cat] if isinstance(pts, list) else [])
        for idx, pts in all_points.items()
    }

    chains = []
    seen_chain_keys = set()

    def dfs(next_idx, assignment):
        if next_idx >= total:
            return True

        pts_full = all_points_full.get(next_idx, [])
        if not pts_full:
            return False

        # Precheck vincoli (assigned -> next_idx): non dipendono dal punto scelto in next_idx
        incoming = _incoming_links_for(next_idx, links, assignment)
        for from_idx, link in incoming:
            from_pt = assignment[from_idx]
            if not _check_link_nearest_distance(from_pt, pts_full, link):
                return False

        # Anchor: se c'è un link (from -> next_idx), scegliamo un punto "rappresentativo" (es. chiesa più vicina al from)
        anchor_pt = None
        if incoming:
            anchor_pt = assignment.get(incoming[0][0])
            candidates = _k_nearest_points(anchor_pt, pts_full, k=40)
        else:
            anchor_pt = assignment.get(next_idx - 1)
            candidates = points_limited.get(next_idx, []) or pts_full
            if anchor_pt:
                candidates = sorted(
                    candidates,
                    key=lambda p: haversine(anchor_pt['lat'], anchor_pt['lon'], p['lat'], p['lon'])
                )

        for cand in candidates:
            # Vincoli (next_idx -> to) verso categorie già assegnate: dipendono dal candidato
            outgoing_to_assigned = _outgoing_links_to_assigned(next_idx, links, assignment)
            ok = True
            for to_idx, link in outgoing_to_assigned:
                to_pts = all_points_full.get(to_idx, [])
                if not _check_link_nearest_distance(cand, to_pts, link):
                    ok = False
                    break
            if not ok:
                continue

            assignment[next_idx] = cand
            if _forward_check(all_points_full, points_limited, links, assignment, total):
                if dfs(next_idx + 1, assignment):
                    return True
            assignment.pop(next_idx, None)
        return False

    start_points = points_limited.get(0, [])[:max_start_points]
    for start_pt in start_points:
        if len(chains) >= max_chains:
            break
        assignment = {0: start_pt}
        if not _forward_check(all_points_full, points_limited, links, assignment, total):
            continue
        if dfs(1, assignment):
            chain_pts = []
            chain_key_parts = []
            for idx in range(total):
                pt = assignment.get(idx)
                if not pt:
                    break
                chain_pts.append(pt)
                k = _point_key(pt) or f"{idx}_?"
                chain_key_parts.append(f"{idx}:{k}")
            if len(chain_pts) == total:
                chain_key = "|".join(chain_key_parts)
                if chain_key not in seen_chain_keys:
                    seen_chain_keys.add(chain_key)
                    chains.append(chain_pts)

    return chains

def search_chain(city, search_radius, chain_definitions, links):
    """Ricerca catena di categorie collegate sequenzialmente."""
    def generate():
        # Validazione
        if not city:
            yield emit({"type":"error","message":"Devi inserire una città."})
            return

        if len(chain_definitions) == 0:
            yield emit({"type":"error","message":"Devi definire almeno una categoria."})
            return

        try:
            # Fase 1: Geocoding città
            yield emit({
                "type":"progress",
                "progress":10,
                "message":"Geocoding della città...",
            })
            bbox = geocode_bbox(city)
            if not bbox:
                yield emit({"type":"error","message":f"Città '{city}' non trovata."})
                return
            
            # Espandi bbox
            lat_lon_str = bbox.split(',')
            min_lat, min_lon, max_lat, max_lon = float(lat_lon_str[0]), float(lat_lon_str[1]), float(lat_lon_str[2]), float(lat_lon_str[3])
            center_lat = (min_lat + max_lat) / 2
            center_lon = (min_lon + max_lon) / 2
            delta_deg = (search_radius / 1000) / 111.0
            expanded_bbox = f"{center_lat - delta_deg},{center_lon - delta_deg},{center_lat + delta_deg},{center_lon + delta_deg}"

            # Fase 2: Scarica punti per tutte le categorie
            all_points = {}
            points_found = {}
            
            for idx, cat_def in enumerate(chain_definitions):
                progress = 15 + (idx / len(chain_definitions)) * 50
                tags = resolve_place(cat_def['name'], mode=cat_def['mode'])
                yield emit({
                    "type":"progress",
                    "progress":int(progress),
                    "message":f"Download {cat_def['name']}...",
                })
                pts = fetch_osm_points_retry_zero(tags, expanded_bbox, retries=1, delay_s=1.0)
                all_points[idx] = pts
                points_found[cat_def['name']] = len(pts)
                time.sleep(0.3)

            # Se alcune categorie risultano a 0, fai un secondo tentativo mirato prima di dare output 0
            zero_idxs = [i for i, pts in all_points.items() if len(pts) == 0]
            if zero_idxs:
                yield emit({
                    "type":"progress",
                    "progress":65,
                    "message":"Ritento download per categorie a 0...",
                    "counts": points_found
                })
                for i in zero_idxs:
                    cat_def = chain_definitions[i]
                    tags = resolve_place(cat_def['name'], mode=cat_def['mode'])
                    pts = fetch_osm_points_retry_zero(tags, expanded_bbox, retries=1, delay_s=1.2)
                    all_points[i] = pts
                    points_found[cat_def['name']] = len(pts)
                    time.sleep(0.2)

            # Verifica
            if all(len(v) == 0 for v in all_points.values()):
                yield emit({
                    "type":"done",
                    "progress":100,
                    "pairs":[],
                    "details": points_found
                })
                return

            # Fase 3: Calcola catene
            yield emit({
                "type":"progress",
                "progress":70,
                "message":"Calcolo catene...",
                "counts":points_found
            })

            chains = build_independent_chains(all_points, chain_definitions, links, max_chains=100)

            # Converti catene in formato output (catene + edge)
            result_chains = []
            result_pairs = []
            for chain_id, chain in enumerate(chains):
                pts_out = []
                for idx, pt in enumerate(chain):
                    pts_out.append({
                        "lat": pt["lat"],
                        "lon": pt["lon"],
                        "name": pt.get("name", "Senza nome"),
                        "category": chain_definitions[idx]["name"],
                        "idx": idx
                    })
                result_chains.append({
                    "id": chain_id,
                    "points": pts_out
                })

                for (from_cat, to_cat), _ in links.items():
                    if from_cat < len(chain) and to_cat < len(chain):
                        pt_from = chain[from_cat]
                        pt_to = chain[to_cat]
                        dist = haversine(pt_from['lat'], pt_from['lon'], pt_to['lat'], pt_to['lon'])
                        result_pairs.append({
                            "chain_id": chain_id,
                            "p1": {
                                "lat": pt_from['lat'],
                                "lon": pt_from['lon'],
                                "name": pt_from.get('name', 'Senza nome'),
                                "category": chain_definitions[from_cat]['name']
                            },
                            "p2": {
                                "lat": pt_to['lat'],
                                "lon": pt_to['lon'],
                                "name": pt_to.get('name', 'Senza nome'),
                                "category": chain_definitions[to_cat]['name']
                            },
                            "dist_m": int(dist),
                            "cat1": chain_definitions[from_cat]['name'],
                            "cat2": chain_definitions[to_cat]['name']
                        })
            
            yield emit({
                "type":"done",
                "progress":100,
                "pairs":result_pairs,
                "chains":result_chains,
                "message":f"Ricerca completata: {len(chains)} catene ({len(result_pairs)} link).",
                "details": points_found
            })

        except Exception as e:
            import traceback
            print(traceback.format_exc())
            yield emit({"type":"error","message":f"Errore server: {str(e)}"})

    return Response(stream_with_context(generate()), mimetype='text/event-stream')

def search_pairs(city, search_radius, pair_definitions):
    """Ricerca coppie indipendenti (legacy)."""


    def generate():
        # Validazione
        if not city:
            yield emit({"type":"error","message":"Devi inserire una città."})
            return

        if len(pair_definitions) == 0:
            yield emit({"type":"error","message":"Devi definire almeno una coppia di categorie."})
            return

        try:
            # Fase 1: Geocoding città
            yield emit({
                "type":"progress",
                "progress":10,
                "message":"Geocoding della città...",
            })
            bbox = geocode_bbox(city)
            if not bbox:
                yield emit({"type":"error","message":f"Città '{city}' non trovata."})
                return
            
            # Espandi il bbox in base al search_radius
            # Sostituisci il bbox per cercare in un'area più ampia
            lat_lon_str = bbox.split(',')
            min_lat, min_lon, max_lat, max_lon = float(lat_lon_str[0]), float(lat_lon_str[1]), float(lat_lon_str[2]), float(lat_lon_str[3])
            center_lat = (min_lat + max_lat) / 2
            center_lon = (min_lon + max_lon) / 2
            
            # Calcola il delta in gradi (approssimato)
            # 1 grado ≈ 111 km
            delta_deg = (search_radius / 1000) / 111.0
            
            expanded_bbox = f"{center_lat - delta_deg},{center_lon - delta_deg},{center_lat + delta_deg},{center_lon + delta_deg}"

            # Fase 2: Raccogli tutte le categorie uniche con i loro mode e scarica i punti
            categories_with_modes = {}  # category -> mode ('list' o 'manual')
            for pair_def in pair_definitions:
                cat1 = pair_def['cat1']
                cat2 = pair_def['cat2']
                if cat1 not in categories_with_modes:
                    categories_with_modes[cat1] = pair_def['mode1']
                if cat2 not in categories_with_modes:
                    categories_with_modes[cat2] = pair_def['mode2']
            
            all_points = {}
            
            for idx, (category, mode) in enumerate(categories_with_modes.items()):
                progress = 15 + (idx / len(categories_with_modes)) * 50
                tags = resolve_place(category, mode=mode)
                yield emit({
                    "type":"progress",
                    "progress":int(progress),
                    "message":f"Download {category}...",
                })
                pts = fetch_osm_points_retry_zero(tags, expanded_bbox, retries=1, delay_s=1.0)
                all_points[category] = pts
                time.sleep(0.3)  # Piccolo delay

            # Secondo tentativo mirato per categorie a 0 (prima di chiudere con 0)
            zero_cats = [cat for cat, pts in all_points.items() if len(pts) == 0]
            if zero_cats:
                yield emit({
                    "type":"progress",
                    "progress":68,
                    "message":"Ritento download per categorie a 0...",
                    "counts": {k: len(v) for k, v in all_points.items()}
                })
                for cat in zero_cats:
                    mode = categories_with_modes.get(cat, 'list')
                    tags = resolve_place(cat, mode=mode)
                    all_points[cat] = fetch_osm_points_retry_zero(tags, expanded_bbox, retries=1, delay_s=1.2)
                    time.sleep(0.2)

            # Verifica che almeno alcuni punti siano stati trovati
            points_found = {k: len(v) for k, v in all_points.items()}
            if all(count == 0 for count in points_found.values()):
                yield emit({
                    "type":"done",
                    "progress":100,
                    "pairs":[],
                    "details": points_found
                })
                return

            # Fase 3: Calcola le coppie per ogni definizione
            yield emit({
                "type":"progress",
                "progress":70,
                "message":"Calcolo coppie...",
                "counts":points_found
            })

            pairs = []
            
            for pair_def in pair_definitions:
                cat1 = pair_def['cat1']
                cat2 = pair_def['cat2']
                max_dist = pair_def['max_distance']
                
                pts1 = all_points.get(cat1, [])
                pts2 = all_points.get(cat2, [])
                
                if len(pts1) == 0 or len(pts2) == 0:
                    continue
                
                # Genera una coppia per ogni punto in cat1 con il suo cat2 più vicino che soddisfa il vincolo
                for a in pts1:
                    closest_valid = None
                    min_dist = float('inf')
                    
                    for b in pts2:
                        d = haversine(a['lat'], a['lon'], b['lat'], b['lon'])
                        if d <= max_dist and d < min_dist:
                            closest_valid = b
                            min_dist = d
                    
                    if closest_valid:
                        pairs.append({
                            "p1": {"lat": a['lat'], "lon": a['lon'], "name": a['name']},
                            "p2": {"lat": closest_valid['lat'], "lon": closest_valid['lon'], "name": closest_valid['name']},
                            "dist_m": int(min_dist),
                            "cat1": cat1,
                            "cat2": cat2
                        })

            # Ordina per distanza
            pairs.sort(key=lambda x: x["dist_m"])
            pairs = pairs[:100]  # Limitiamo a 100 per non intasare la mappa
            
            yield emit({
                "type":"done",
                "progress":100,
                "pairs":pairs,
                "message":f"Ricerca completata: {len(pairs)} coppie.",
                "details": points_found
            })

        except Exception as e:
            import traceback
            print(traceback.format_exc())
            yield emit({"type":"error","message":f"Errore server: {str(e)}"})

    return Response(stream_with_context(generate()), mimetype='text/event-stream')

if __name__ == "__main__":
    app.run(debug=True)
