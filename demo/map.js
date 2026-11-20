const MAX_ZOOM = 48;
const WIDTH = 360;
const HEIGHT = 180;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pathsFrom(polygons, colorFor) {
  const zones = new Map();
  for (const { tzid, rings } of polygons) {
    let zone = zones.get(tzid);
    if (!zone) {
      zone = {
        path: new Path2D(),
        bounds: [Infinity, Infinity, -Infinity, -Infinity],
        ocean: /^Etc\/GMT(?:[+-]\d+)?$/.test(tzid),
        color: colorFor(tzid),
      };
      zones.set(tzid, zone);
    }
    const { path, bounds } = zone;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i] + 180;
        const y = 90 - ring[i + 1];
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
      path.closePath();
    }
  }
  return zones;
}

export class ZoneMap {
  constructor(canvas, polygons, colorFor, onPick, onViewChange) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.background = document.createElement('canvas');
    this.backgroundContext = this.background.getContext('2d');
    if (!this.context || !this.backgroundContext) throw new Error('Could not open the map canvas');
    this.paths = pathsFrom(polygons, colorFor);
    this.drawOrder = [...this.paths.values()].sort((a, b) => Number(b.ocean) - Number(a.ocean));
    this.onPick = onPick;
    this.onViewChange = onViewChange;
    this.zoom = 1;
    this.center = [180, 90];
    this.dirty = true;
    this.frame = 0;
    this.bindControls();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = width;
    this.height = height;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.fit = Math.max(.1, Math.min((width - 22) / WIDTH, (height - 22) / HEIGHT));
    this.canvas.width = this.background.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = this.background.height = Math.max(1, Math.round(height * this.dpr));
    this.constrain();
    this.schedule(true);
  }

  transform() {
    const scale = this.fit * this.zoom;
    return {
      scale,
      x: this.width / 2 - this.center[0] * scale,
      y: this.height / 2 - this.center[1] * scale,
    };
  }

  constrain() {
    const scale = this.fit * this.zoom;
    const halfWidth = this.width / (2 * scale);
    const halfHeight = this.height / (2 * scale);
    this.center[0] = halfWidth >= 180 ? 180 : clamp(this.center[0], halfWidth, WIDTH - halfWidth);
    this.center[1] = halfHeight >= 90 ? 90 : clamp(this.center[1], halfHeight, HEIGHT - halfHeight);
  }

  changeZoom(factor, x = this.width / 2, y = this.height / 2) {
    const next = clamp(this.zoom * factor, 1, MAX_ZOOM);
    if (next === this.zoom) return;
    const before = this.transform();
    const worldX = (x - before.x) / before.scale;
    const worldY = (y - before.y) / before.scale;
    const scale = this.fit * next;
    this.zoom = next;
    this.center = [worldX - (x - this.width / 2) / scale, worldY - (y - this.height / 2) / scale];
    this.constrain();
    this.schedule(true);
    this.onViewChange();
  }

  reset() {
    this.zoom = 1;
    this.center = [180, 90];
    this.schedule(true);
    this.onViewChange();
  }

  zoomLimits() {
    return { canZoomIn: this.zoom < MAX_ZOOM, canZoomOut: this.zoom > 1 };
  }

  pan(dx, dy) {
    const scale = this.fit * this.zoom;
    this.center[0] -= dx / scale;
    this.center[1] -= dy / scale;
    this.constrain();
    this.schedule(true);
  }

  select(lon, lat, tzid, reveal) {
    this.marker = { x: lon + 180, y: 90 - lat, tzid };
    const { scale, x, y } = this.transform();
    const screenX = this.marker.x * scale + x;
    const screenY = this.marker.y * scale + y;
    const clipped = screenX < 8 || screenX > this.width - 8 || screenY < 8 || screenY > this.height - 8;
    if (reveal && clipped) {
      this.center = [this.marker.x, this.marker.y];
      this.constrain();
      this.schedule(true);
    } else {
      this.schedule(false);
    }
  }

  pick(x, y) {
    const view = this.transform();
    const lon = (x - view.x) / view.scale - 180;
    const lat = 90 - (y - view.y) / view.scale;
    if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
      this.onPick(Number(lon.toFixed(6)), Number(lat.toFixed(6)));
    }
  }

  bindControls() {
    const canvas = this.canvas;
    const eventPosition = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    let drag;
    const endDrag = () => {
      drag = undefined;
      delete canvas.dataset.dragging;
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      const [x, y] = eventPosition(event);
      drag = { id: event.pointerId, initialX: x, initialY: y, x, y, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const [x, y] = eventPosition(event);
      if (!drag.moved && Math.hypot(x - drag.initialX, y - drag.initialY) < 4) return;
      drag.moved = true;
      canvas.dataset.dragging = '';
      this.pan(x - drag.x, y - drag.y);
      drag.x = x;
      drag.y = y;
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moved) this.pick(...eventPosition(event));
      endDrag();
    });
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.changeZoom(Math.exp(-clamp(event.deltaY, -300, 300) * .003), ...eventPosition(event));
    }, { passive: false });
    canvas.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowLeft': this.pan(50, 0); break;
        case 'ArrowRight': this.pan(-50, 0); break;
        case 'ArrowUp': this.pan(0, 50); break;
        case 'ArrowDown': this.pan(0, -50); break;
        case '+': case '=': this.changeZoom(1.45); break;
        case '-': this.changeZoom(1 / 1.45); break;
        case 'Home': this.reset(); break;
        case 'Enter': this.pick(this.width / 2, this.height / 2); break;
        default: return;
      }
      event.preventDefault();
    });
  }

  schedule(background) {
    this.dirty ||= background;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const view = this.transform();
      if (this.dirty) {
        this.drawBackground(view);
        this.dirty = false;
      }
      this.drawSelection(view);
    });
  }

  drawBackground({ scale, x, y }) {
    const ctx = this.backgroundContext;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101d30';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#142337';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const visible = [-x / scale, -y / scale, (this.width - x) / scale, (this.height - y) / scale];
    ctx.lineJoin = 'round';
    for (const zone of this.drawOrder) {
      const [west, north, east, south] = zone.bounds;
      if (east < visible[0] || south < visible[1] || west > visible[2] || north > visible[3]) continue;
      ctx.fillStyle = zone.color;
      ctx.globalAlpha = zone.ocean ? .16 : .76;
      ctx.fill(zone.path, 'evenodd');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = zone.ocean ? '#7597bc35' : '#c3d9ef8c';
      ctx.lineWidth = (zone.ocean ? .6 : .73) / scale;
      ctx.stroke(zone.path);
    }
    ctx.beginPath();
    const step = [30, 15, 5, 2, 1, .5].find((spacing) => spacing * scale < 145) ?? .5;
    for (let lon = step; lon < WIDTH; lon += step) {
      if (lon < visible[0] || lon > visible[2]) continue;
      ctx.moveTo(lon, 0);
      ctx.lineTo(lon, HEIGHT);
    }
    for (let lat = step; lat < HEIGHT; lat += step) {
      if (lat < visible[1] || lat > visible[3]) continue;
      ctx.moveTo(0, lat);
      ctx.lineTo(WIDTH, lat);
    }
    ctx.strokeStyle = '#c5d7f031';
    ctx.lineWidth = .75 / scale;
    ctx.setLineDash([2 / scale, 4 / scale]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#83a2c34f';
    ctx.strokeRect(0, 0, WIDTH, HEIGHT);
    ctx.restore();
  }

  drawSelection({ scale, x, y }) {
    const ctx = this.context;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.background, 0, 0);
    if (!this.marker) return;
    const zone = this.paths.get(this.marker.tzid);
    if (zone) {
      ctx.save();
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
      ctx.fillStyle = '#79ecd256';
      ctx.fill(zone.path, 'evenodd');
      ctx.strokeStyle = '#a2fcdf';
      ctx.lineWidth = 1.6 / scale;
      ctx.lineJoin = 'round';
      ctx.stroke(zone.path);
      ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = this.marker.x * scale + x;
    const py = this.marker.y * scale + y;
    ctx.beginPath();
    ctx.arc(px, py, 10, 0, 2 * Math.PI);
    ctx.fillStyle = '#9af9e160';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#c1ffee';
    ctx.fill();
    ctx.strokeStyle = '#132c36';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
