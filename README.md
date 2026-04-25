# Nova Blaster 🚀

A high-octane, retro-inspired 2D platformer built with **vanilla JavaScript** and **HTML5 Canvas**. Navigate through neon-drenched levels, master the dash mechanic, and take down powerful bosses with your multi-stage charge shot.

---

## 🎮 Live Demo
Simply open `index.html` in any modern web browser to play. 
*Tip: Click the game window once to enable keyboard controls and audio.*

---

## 🕹️ Controls

| Action | Key(s) |
| :--- | :--- |
| **Move** | `A` / `D` or `Left` / `Right Arrow` |
| **Jump / Double Jump** | `W` / `Space` / `Up Arrow` |
| **Fire / Charge Shot** | `J` (Hold to charge, Release to fire) |
| **Dash** | `K` |

---

## ✨ Key Features

### ⚔️ Combat System
* **Nova Charge:** Hold the fire button to charge a massive projectile that deals $6\times$ the damage of a standard shot.
* **Tactical Dash:** Grants a brief window of invulnerability and high horizontal velocity—perfect for dodging projectiles or clearing massive pits.
* **Object Pooling:** High-performance bullet management ensures smooth gameplay even with hundreds of active projectiles.

### 🏃 Modern Platforming Feel
* **Coyote Time:** A brief grace period allowing you to jump even after sliding off a ledge.
* **Jump Buffering:** Your jump will register even if you press the button slightly before hitting the ground.
* **Variable Jump Height:** Control your arc by holding or releasing the jump key.

### 🌎 World & AI
* **4 Unique Levels:** Progress from the *Neon Ruins* to the *Solar Core*.
* **Diverse Enemies:** Face ground-based Walkers, ceiling Turrets, and hovering Drones.
* **Boss Encounters:** Every level ends with a unique boss fight requiring specific patterns to defeat.

---

## 🛠️ Technical Overview

* **Language:** JavaScript (ES6+)
* **Rendering:** HTML5 Canvas API (Pixel-art optimized)
* **Physics:** Custom Axis-Separated AABB collision detection at $120\text{Hz}$.
* **Audio:** Real-time 8-bit sound synthesis using the **Web Audio API** (No external `.wav` or `.mp3` files needed!).
* **State Management:** Robust game-state machine handling Intro, Playing, Game Over, and Win states.

---

## 📂 File Structure

```text
├── index.html      # Main game structure and canvas
├── styles.css      # Retro UI styling and layout
└── script.js       # Core game engine, AI, and physics
