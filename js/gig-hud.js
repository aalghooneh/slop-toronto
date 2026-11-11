import * as THREE from 'three/webgpu';
import { getLocationLabel } from './city-config.js';

// js/gig-hud.js
// Toronto Hustle on screen: the wallet (cash, rank, streak, raccoons), the card for the job in hand, the marker that
// floats over wherever the player is being sent (or points to it from the edge of the screen), the payout card and
// the little toasts for driving with style. The DOM is only touched when what it shows changes.

const KIND_LABEL = { fare: 'Cab', delivery: 'Courier', tour: 'Air tour' };
const INTRO_KEY = 'toronto-hustle-intro';

const el = (id) => document.getElementById(id);

function formatDistance(m) {
  if (m >= 950) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

function formatTime(s) {
  const late = s < 0;
  s = Math.ceil(Math.abs(s));
  return `${late ? '+' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Sets an element's text only when it changes; returns whether it did
function setText(node, text) {
  if (!node || node._text === text) return false;
  node._text = text;
  node.textContent = text;
  return true;
}

function setHidden(node, hidden) {
  if (node && node.hidden !== hidden) node.hidden = hidden;
}

class GigHud {
  constructor(gigs, { onStart = () => {} } = {}) {
    this.gigs = gigs;
    this.wallet = el('wallet');
    this.card = el('gig-card');
    this.marker = el('gig-marker');
    this.payout = el('gig-payout');
    this.toasts = el('gig-toasts');
    this.intro = el('gig-intro');
    this.shownCash = gigs.cash;
    this.payoutTimer = 0;
    this.notices = [];
    this._v = new THREE.Vector3();
    this.frame = 0;
    setText(el('wallet-cash'), gigs.cash.toLocaleString('en-US'));

    // The briefing, on a first visit
    let seen = false;
    try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch { /* Private browsing. */ }
    this.introOpen = false;
    const start = el('gig-intro-start');
    if (start) start.addEventListener('click', () => this.closeIntro());
    this.onStart = onStart;
    this.wantIntro = !seen;
  }

  showIntro() {
    if (!this.intro || !this.wantIntro) return;
    this.wantIntro = false;
    this.introOpen = true;
    this.intro.hidden = false;
  }

  closeIntro() {
    if (!this.introOpen) return;
    this.introOpen = false;
    this.intro.classList.add('is-leaving');
    setTimeout(() => { this.intro.hidden = true; }, 450);
    try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* Storage may be disabled. */ }
    this.onStart();
  }

  toast(text, tone = '', sub = '') {
    if (!this.toasts) return;
    const node = document.createElement('div');
    node.className = `gig-toast${tone ? ` is-${tone}` : ''}`;
    const main = document.createElement('span');
    main.textContent = text;
    node.appendChild(main);
    if (sub) {
      const extra = document.createElement('b');
      extra.textContent = sub;
      node.appendChild(extra);
    }
    this.toasts.appendChild(node);
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
    setTimeout(() => node.classList.add('is-leaving'), 2300);
    setTimeout(() => node.remove(), 2800);
  }

  showPayout(title, total, detail, stars = 0, tone = 'good', seconds = 3.6) {
    if (!this.payout) return;
    setText(el('payout-title'), title);
    setText(el('payout-total'), total);
    setText(el('payout-detail'), detail);
    const starsEl = el('payout-stars');
    if (starsEl) {
      starsEl.hidden = !stars;
      starsEl.replaceChildren(...Array.from({ length: stars ? 5 : 0 }, (_, i) => {
        const s = document.createElement('span');
        s.textContent = '★';
        s.className = i < stars ? 'is-on' : '';
        s.style.animationDelay = `${0.12 + i * 0.07}s`;
        return s;
      }));
    }
    this.payout.dataset.tone = tone;
    this.payout.hidden = false;
    // (restart the entrance animation)
    this.payout.classList.remove('is-in');
    void this.payout.offsetWidth;
    this.payout.classList.add('is-in');
    this.payoutTimer = seconds;
  }

  onEvent(type, data) {
    switch (type) {
      case 'accept':
        if (data.job.kind === 'tour') this.toast('Tour started', 'tour', `${data.job.rings.length - 1} rings`);
        break;
      case 'boarded':
        this.toast(data.job.kind === 'fare' ? `${data.job.name} is in` : 'Order collected', data.job.kind, `to ${data.job.dest.place.split(' · ')[0]}`);
        break;
      case 'late':
        this.toast(data.job.kind === 'fare' ? `${data.job.name} is getting impatient` : 'The order is going cold', 'bad');
        break;
      case 'hit':
        if (data.pedestrian) this.toast('You hit someone!', 'bad', data.job ? 'rating down' : '');
        else if (data.job?.kind === 'fare') this.toast(data.job.persona === 'thrill' ? 'Whoa! Easy!' : 'Watch it!', 'bad', 'rating down');
        else if (data.job?.kind === 'delivery') this.toast('The order took a knock', 'bad');
        break;
      case 'ring':
        if (data.index > 0 && !data.last) this.toast(data.job.rings[data.index].name, 'tour', `${data.index} / ${data.job.rings.length - 1}`);
        break;
      case 'style':
        this.toast(data.label, 'style', `+$${data.amount}${data.combo > 1 ? ` ×${data.combo}` : ''}${data.loved ? ' · they love it' : ''}`);
        break;
      case 'raccoon':
        this.showPayout('Raccoon found', `${data.count} / ${data.total}`, `Raiding a green bin near ${data.raccoon.near} · +$25`, 0, 'raccoon', 3);
        break;
      case 'rank':
        this.notices.push({ title: 'Rank up', total: data.name, detail: 'The city is starting to know your name.', tone: 'rank' });
        break;
      case 'notice':
        if (data.big) this.notices.push({ title: 'Legend', total: 'Raccoon Whisperer', detail: data.text, tone: 'rank' });
        else this.toast(data.text, data.tone || '');
        break;
      case 'enabled':
        this.toast(data.enabled ? 'On the clock' : 'Off the clock: free roam', data.enabled ? 'good' : '', data.enabled ? 'gigs on' : 'gigs off');
        break;
      case 'complete': {
        const { job, fare, tip, stars, multiplier, total, late } = data;
        const title = job.kind === 'fare' ? (late ? 'Fare delivered late' : 'Fare complete') : job.kind === 'delivery' ? (late ? 'Delivered cold' : 'Order delivered') : 'Tour complete';
        const parts = [`${job.kind === 'tour' ? 'Tour' : job.kind === 'fare' ? 'Fare' : 'Delivery'} $${fare}`];
        if (tip) parts.push(`${job.kind === 'tour' ? 'Time bonus' : 'Tip'} $${tip}`);
        if (multiplier > 1) parts.push(`Streak ×${multiplier.toFixed(1)}`);
        if (job.styleCash) parts.push(`Style $${job.styleCash}`);
        this.showPayout(title, `+$${total}`, parts.join('  ·  '), stars, late ? 'late' : 'good');
        break;
      }
      case 'fail': {
        const { job, reason } = data;
        if (reason === 'left') {
          this.toast(job.kind === 'fare' ? `You left ${job.name} at the kerb` : 'You left without the order', 'bad');
          break;
        }
        const what = job.kind === 'fare' ? 'Fare lost' : job.kind === 'delivery' ? 'Delivery failed' : 'Tour over';
        const why = reason === 'timeout'
          ? (job.kind === 'fare' ? `${job.name} got out and walked.` : job.kind === 'delivery' ? 'The customer cancelled the order.' : 'Out of time.')
          : reason === 'wrecked' ? 'The car is wrecked.' : 'You walked away from the job.';
        this.showPayout(what, '$0', why, 0, 'bad', 2.8);
        break;
      }
    }
  }

  updateWallet(dt) {
    const gigs = this.gigs;
    setHidden(this.wallet, false);
    // the cash counts up to what was earned
    if (this.shownCash !== gigs.cash) {
      const gap = gigs.cash - this.shownCash;
      const step = Math.sign(gap) * Math.max(1, Math.ceil(Math.abs(gap) * Math.min(1, dt * 6)));
      this.shownCash = Math.abs(step) >= Math.abs(gap) ? gigs.cash : this.shownCash + step;
      setText(el('wallet-cash'), this.shownCash.toLocaleString('en-US'));
      this.wallet.classList.toggle('is-earning', gap > 0);
    } else {
      this.wallet.classList.remove('is-earning');
    }
    if ((this.frame & 15) !== 0) return;
    const rank = gigs.rank;
    setText(el('wallet-rank'), rank.name);
    setText(el('wallet-next'), rank.next ? `$${rank.toNext.toLocaleString('en-US')} to ${rank.next}` : 'Top of the city');
    const bar = el('wallet-progress');
    const p = Math.round(rank.progress * 1000) / 1000;
    if (bar && bar._p !== p) {
      bar._p = p;
      bar.style.transform = `scaleX(${p})`;
    }
    const streak = el('wallet-streak');
    setHidden(streak, gigs.streak < 2);
    setText(streak, `Streak ${gigs.streak} · ×${(1 + Math.min(10, Math.max(0, gigs.streak - 1)) * 0.1).toFixed(1)}`);
    setText(el('wallet-raccoons'), `${gigs.found.size} / ${gigs.raccoonTotal || 40} raccoons`);
  }

  updateCard(entity, mode) {
    const gigs = this.gigs;
    const job = gigs.job;
    const card = this.card;
    let kind = '';
    let title = '';
    let pay = '';
    let line = '';
    let step = '';
    let dist = '';
    let time = null;
    let ratio = 0;
    let tone = '';

    if (mode === 'person') {
      kind = 'On foot';
      const left = gigs.raccoonTotal - gigs.found.size;
      title = left ? 'Raccoon hunt' : 'Every raccoon found';
      const d = gigs.raccoonNear;
      step = !left ? 'Hop in a vehicle to work a gig'
        : d < 14 ? 'It\'s right here. Check the green bins!'
        : d < 35 ? 'Chittering, very close…'
        : d < 70 ? 'Something is rustling nearby'
        : d < 130 ? 'A faint smell of green bin on the wind'
        : 'Nothing rustling here. They like parks and landmarks';
      pay = `${gigs.found.size} / ${gigs.raccoonTotal}`;
      tone = d < 70 && left ? 'raccoon' : '';
    } else if (job) {
      kind = KIND_LABEL[job.kind];
      pay = `$${job.pay}`;
      tone = job.kind;
      if (job.kind === 'tour') {
        const ring = job.rings[job.ring];
        title = 'Skyline tour';
        step = `Ring ${job.ring} of ${job.rings.length - 1}: ${ring.name}`;
        time = job.timeLeft;
        ratio = job.timeLeft / job.timeLimit;
      } else if (job.stage === 'boarding') {
        title = job.title;
        step = job.kind === 'fare' ? `${job.name} is getting in…` : `Collecting ${job.order}…`;
      } else {
        title = job.title;
        line = job.line;
        step = `${job.kind === 'fare' ? 'Drop off at' : 'Deliver to'} ${job.dest.place.split(' · ')[0]}`;
        time = job.timeLeft;
        ratio = job.timeLeft / job.timeLimit;
        if (job.late) tone = 'late';
      }
      dist = job.stage === 'boarding' ? '' : formatDistance(gigs.distanceLeft(entity));
    } else if (gigs.offers.length) {
      const o = gigs.target?.ref;
      kind = KIND_LABEL[gigs.offers[0].kind];
      tone = gigs.offers[0].kind;
      if (o && o.kind === 'tour') {
        title = o.title;
        step = 'Fly through the ring to start';
        line = o.line;
        pay = `$${o.pay}+`;
      } else if (o) {
        title = o.title;
        step = `${o.kind === 'fare' ? 'Pick up at' : 'Collect at'} ${getLocationLabel(o.x, o.z).split(' · ').pop()}`;
        pay = `$${o.pay}+`;
      }
      dist = o ? formatDistance(gigs.distanceLeft(entity)) : '';
    } else {
      kind = KIND_LABEL[mode === 'car' ? 'fare' : mode === 'cyclist' ? 'delivery' : 'tour'];
      title = 'Looking for work…';
    }

    setHidden(card, false);
    if (card.dataset.tone !== tone) card.dataset.tone = tone;
    setText(el('gig-kind'), kind);
    setText(el('gig-title'), title);
    setText(el('gig-pay'), pay);
    const lineEl = el('gig-line');
    setHidden(lineEl, !line);
    setText(lineEl, line ? `“${line}”` : '');
    setText(el('gig-step'), step);
    setText(el('gig-dist'), dist);
    const timeEl = el('gig-time');
    const meter = el('gig-meter');
    setHidden(timeEl, time === null);
    setHidden(meter, time === null);
    if (time !== null) {
      setText(timeEl, formatTime(time));
      const bar = el('gig-timer-bar');
      const r = Math.round(Math.max(0, Math.min(1, ratio)) * 200) / 200;
      if (bar._r !== r) {
        bar._r = r;
        bar.style.transform = `scaleX(${r})`;
      }
      const urgent = ratio < 0.25;
      if (card._urgent !== urgent) {
        card._urgent = urgent;
        card.classList.toggle('is-urgent', urgent);
      }
    } else if (card._urgent) {
      card._urgent = false;
      card.classList.remove('is-urgent');
    }
  }

  // The marker over the target, or at the edge of the screen pointing the way to it
  updateMarker(entity, camera) {
    const target = this.gigs.target;
    const marker = this.marker;
    if (!target || !marker) return setHidden(marker, true);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const lift = target.kind === 'ring' || target.ref?.kind === 'tour' ? 0 : 9;
    const v = this._v.set(target.x, (target.y || 0) + lift, target.z).applyMatrix4(camera.matrixWorldInverse);
    const behind = v.z > -0.5;
    v.applyMatrix4(camera.projectionMatrix);
    let nx = v.x;
    let ny = v.y;
    if (behind) {
      nx = -nx;
      ny = -ny;
    }
    const mx = 1 - 70 / (w * 0.5);
    const my = 1 - 96 / (h * 0.5);
    const off = behind || Math.abs(nx) > mx || Math.abs(ny) > my;
    let angle = 0;
    if (off) {
      if (behind && Math.abs(nx) < 0.05 && Math.abs(ny) < 0.05) ny = -1; // straight behind: point down
      const k = Math.max(Math.abs(nx) / mx, Math.abs(ny) / my, 1e-6);
      nx /= k;
      ny /= k;
      angle = Math.atan2(nx * w, ny * h); // 0 = up the screen, clockwise
    }
    const x = Math.round((nx * 0.5 + 0.5) * w);
    const y = Math.round((-ny * 0.5 + 0.5) * h);
    setHidden(marker, false);
    marker.style.transform = `translate(${x}px, ${y}px)`;
    if (marker._off !== off) {
      marker._off = off;
      marker.classList.toggle('is-off', off);
    }
    const kind = target.kind === 'offer' ? target.ref.kind : target.kind;
    if (marker.dataset.kind !== kind) marker.dataset.kind = kind;
    marker.firstElementChild.style.transform = off ? `rotate(${angle}rad)` : '';
    if ((this.frame & 7) === 0) {
      const d = Math.hypot(target.x - entity.position.x, (target.y || 0) - entity.position.y, target.z - entity.position.z);
      setText(el('gig-marker-label'), formatDistance(d));
    }
  }

  update(dt, entity, mode, camera) {
    this.frame++;
    const gigs = this.gigs;
    this.updateWallet(dt);
    if (!gigs.enabled && mode !== 'person') {
      setHidden(this.card, true);
      setHidden(this.marker, true);
    } else {
      if ((this.frame & 3) === 0) this.updateCard(entity, mode);
      if (gigs.enabled) this.updateMarker(entity, camera);
      else setHidden(this.marker, true);
    }
    if (this.payoutTimer > 0) {
      this.payoutTimer -= dt;
      if (this.payoutTimer <= 0) {
        this.payout.classList.remove('is-in');
        this.payout.hidden = true;
      }
    } else if (this.notices.length) {
      const n = this.notices.shift();
      this.showPayout(n.title, n.total, n.detail, 0, n.tone, 3.4);
    }
  }
}

export { GigHud, formatDistance, formatTime };
