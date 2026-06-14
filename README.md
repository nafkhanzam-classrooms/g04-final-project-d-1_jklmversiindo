# WordFuse - Laporan Final Project ProgJar

ProgJar(D) <br>
Institut Teknologi Sepuluh Nopember (ITS) <br>
Melvan Hapianan Allo Ponglabba <br>
5025241124 <br>

---

## Daftar Isi

1. [Pendahuluan](#1-pendahuluan)
2. [Deskripsi dan Tujuan Project](#2-deskripsi-dan-tujuan-project)
3. [Arsitektur Sistem](#3-arsitektur-sistem)
4. [Desain Protokol Aplikasi](#4-desain-protokol-aplikasi)
5. [Pengujian Performa dan Beban Server](#5-pengujian-performa-dan-beban-server)
6. [Hasil dan Analisis](#6-hasil-dan-analisis)
7. [Kendala dan Solusi](#7-kendala-dan-solusi)
8. [Kesimpulan dan Saran](#8-kesimpulan-dan-saran)
9. [Lampiran: Cara Menjalankan Aplikasi](#9-lampiran-cara-menjalankan-aplikasi)

---

## 1. Pendahuluan

### 1.1 Latar Belakang

Game multiplayer real-time adalah salah satu cara paling langsung untuk merasakan konsep jaringan komputer secara nyata. Tidak seperti aplikasi web biasa yang cukup dengan HTTP request-response, game semacam ini butuh komunikasi dua arah yang terus-menerus antara server dan banyak klien sekaligus. Kalau latensinya tinggi atau state-nya tidak sinkron, pemain langsung merasakannya jadi pilihan protokol, model komunikasi, dan cara sinkronisasi state bukan sekadar teori.

Lewat project ini, banyak topik mata kuliah yang jadi konkret: socket programming, model klien–server, broadcast di LAN, perbandingan WebSocket vs HTTP polling, binding antarmuka jaringan (loopback vs `0.0.0.0`), sampai perbedaan antara penyimpanan in-memory yang volatil dengan database persisten.

### 1.2 Rumusan Masalah

Masalah utamanya: bagaimana caranya semua browser di perangkat yang berbeda-beda bisa melihat state permainan yang sama, pada waktu yang (hampir) bersamaan, tanpa bergantung pada internet atau hosting berbayar?

Lebih spesifik, ada empat hal yang perlu diselesaikan:

1. Server harus bisa menerima koneksi dari banyak browser sekaligus tanpa polling.
2. Setiap perubahan state siapa giliran berikutnya, suku kata aktif, sisa waktu harus sampai ke semua pemain dengan cepat.
3. Timer tidak boleh dipercayakan ke klien. Kalau klien yang pegang timer, orang bisa curang dengan mengutak-atik jam lokalnya. Server harus jadi satu-satunya penentu kapan waktu habis.
4. Kalau pemain tiba-tiba disconnect atau refresh tab, dia tidak langsung kalah sistem harus bisa mengenalinya kembali.

### 1.3 Ruang Lingkup

Ruang lingkup project ini sengaja dibatasi agar fokus pada konsep jaringan, bukan pada infrastruktur produksi:

- **Hanya berjalan di LAN.** Tidak ada *cloud hosting*, *reverse proxy*, atau *domain name*. Mesin host menjalankan seluruh komponen secara lokal; perangkat lain terhubung melalui alamat IP LAN host.
- **Klien sepenuhnya berbasis browser.** Tidak ada aplikasi *native* iOS/Android. Setiap perangkat hanya membutuhkan browser modern.
- **Tanpa autentikasi atau akun pengguna.** Identitas pemain disimpan secara *opaque* sebagai UUID di `localStorage` masing-masing browser.
- **Satu sesi permainan per host.** Tidak ada *room system*; semua pemain yang join ke server yang sama berada dalam satu *match* yang sama.
- **Tanpa spectator mode terpisah.** Pemain yang sudah tereliminasi tetap bisa menonton dan ikut chat, tapi tidak bisa mengirim kata.

---

## 2. Deskripsi dan Tujuan Project

### 2.1 Deskripsi WordFuse

**WordFuse** adalah permainan kata multiplayer real-time bertempo cepat yang dimainkan langsung di dalam browser web. 2 hingga 6 pemain bergabung ke dalam sebuah *lobby* lokal melalui jaringan WiFi yang sama, lalu host memulai permainan dengan satu klik. Setelah pertandingan dimulai, mekanika inti adalah sebagai berikut:

1. Server memilih sebuah suku kata secara acak dari *tier* yang sesuai dengan ronde saat ini (contoh: `KA`, `PRO`, `STR`).
2. Sebuah "bom" virtual diberikan kepada salah satu pemain. Timer mundur server-authoritative mulai berjalan dan disiarkan ke seluruh peserta setiap 200 ms.
3. Pemain aktif harus mengetik **sebuah kata Bahasa Indonesia yang valid** dan **mengandung suku kata tersebut sebagai substring**, lalu menekan Enter sebelum timer habis.
4. Jika kata diterima, bom berpindah ke pemain berikutnya dalam urutan, suku kata baru dipilih, dan timer ronde berikutnya dimulai.
5. Jika kata ditolak (tidak ada di kamus / tidak mengandung suku kata) atau timer habis, pemain aktif kehilangan satu nyawa. Setiap pemain mulai dengan 3 nyawa.
6. Pemain dengan 0 nyawa tereliminasi. Permainan berakhir saat tinggal satu pemain tersisa pemain itu menjadi pemenang. Hasil disimpan ke SQLite dan ditampilkan pada layar hasil.

Tingkat kesulitan meningkat seiring berjalannya ronde:

| Ronde | Durasi Timer | Tipe Suku Kata |
|---|---|---|
| 1 – 3 | 10 detik | 2 huruf umum (`AN`, `IN`, `KA`, `MA`, dll.) |
| 4 – 6 | 8 detik | 3 huruf (`PRO`, `KAN`, `BER`, `MEN`, dll.) |
| 7+ | 5 detik | suku kata sulit (`NGKU`, `STR`, `PSI`, `FLU`, dll.) |

### 2.2 Tujuan

Dari sisi teknis, project ini punya beberapa tujuan konkret:

- Mengganti model HTTP biasa dengan WebSocket via Socket.io untuk komunikasi dua arah yang real-time.
- Memastikan semua klien browser di satu LAN melihat state permainan yang konsisten ronde yang sama, suku kata yang sama, giliran yang sama.
- Membuat timer yang sepenuhnya dikontrol server menggunakan Redis TTL, sehingga klien tidak bisa curang dengan manipulasi waktu.
- Menyimpan hasil pertandingan ke SQLite supaya data tetap ada walau server di-restart.
- Validasi kata Bahasa Indonesia dilakukan di server menggunakan `Set<string>` in-memory agar lookup-nya O(1) dan tidak menambah latensi.
- Menambahkan chat global yang bisa dipakai semua pemain termasuk yang sudah tereliminasi lewat koneksi WebSocket yang sama, tanpa koneksi baru.
- Memberikan feedback visual yang cukup jelas di setiap momen penting: kata diterima, ditolak, nyawa hilang, pemain gugur, bom berpindah, sampai kemenangan.

---

## 3. Arsitektur Sistem

### 3.1 Tinjauan Tiga Lapisan Lokal

Seluruh sistem berjalan pada satu mesin host. Tidak ada komponen yang dideploy ke internet. Sistem terdiri dari tiga lapisan logis:

```
┌──────────────────────────────────────────────────────────────────┐
│                      Mesin Host (LAN)                            │
│                                                                  │
│  ┌──────────────┐     ┌──────────────────────────────────────┐   │
│  │  Browser     │     │  Node.js process                     │   │
│  │  (host /     │ ◄─► │                                      │   │
│  │   peer LAN)  │     │  Express :3000   (static frontend)   │   │
│  └──────────────┘     │  Socket.io :3001 (WebSocket gameplay)│   │
│         ▲             │                                      │   │
│         │ HTTP/WS     │  gameManager.js                      │   │
│  ┌──────┴───────┐     │  timerManager.js  ──── PTTL ───┐     │   │
│  │  Browser     │     │  wordValidator.js              │     │   │
│  │  (peer LAN)  │     │  db.js                         │     │   │
│  └──────────────┘     └────────────────────────────────┼─────┘   │
│                                                        │         │
│                         ┌──────────┐         ┌─────────▼──────┐  │
│                         │ SQLite   │         │ Redis :6379    │  │
│                         │ wordfuse │         │ (loopback only)│  │
│                         │ .db      │         │                │  │
│                         └──────────┘         └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Lapisan klien.** Setiap pemain membuka browser di perangkat masing-masing dan menavigasi ke `http://<host-ip>:3000`. Tiga berkas frontend berikut dimuat statis dari host:

- `public/index.html` kerangka satu halaman dengan tiga *screen* (Join, Game, Results) yang ditampilkan/disembunyikan via kelas CSS (`screen-join`, `screen-game`, `screen-results`).
- `public/style.css` *dark theme*, animasi bom yang berdenyut (warnanya bergeser hijau → kuning → merah seiring berkurangnya waktu), serta `text-transform: uppercase` pada input kata.
- `public/game.js` modul kontroler klien yang membuka koneksi Socket.io ke port 3001, menangani seluruh event server, dan memperbarui DOM tanpa *page reload*.

**Lapisan backend.** Satu proses Node.js menjalankan dua server HTTP yang independen:

- `server/index.js` adalah *entry point* yang melakukan inisialisasi berurutan: `db.init()` → `wordValidator.loadDictionary()` → `redisClient.getClient().ping()` → `app.listen(3000, '0.0.0.0')` → Socket.io `httpServer.listen(3001, '0.0.0.0')`.
- `server/gameManager.js` modul aturan permainan: registrasi pemain, pemilihan host, urutan giliran sirkular, sistem nyawa, pemilihan suku kata per ronde, kondisi menang, dan persistensi ke SQLite saat *game over*.
- `server/wordValidator.js` validator murni dengan API `loadDictionary(path)`, `dictionarySize()`, dan `isValid(word, syllable)` yang mengembalikan `{ ok: true }` atau `{ ok: false, reason: 'EMPTY' | 'NOT_IN_DICTIONARY' | 'MISSING_SYLLABLE' }`.
- `server/timerManager.js` countdown server-authoritative berbasis Redis TTL.
- `server/syllableTiers.js` tabel tiga *tier* dan fungsi `pickSyllable(round)` serta `timerForRound(round)`.
- `server/redisClient.js` *singleton* `ioredis` yang lazy-connect ke `127.0.0.1:6379`.
- `server/db.js` abstraksi `better-sqlite3` dengan tabel `players`, `matches`, dan `match_players`.

**Lapisan data.** Dua *backend storage* yang saling melengkapi:

- **Redis** (`localhost:6379`) menyimpan state ephemeral pertandingan: hash `game:state` (suku kata aktif, id pemain aktif, ronde), list `game:turn_order` (urutan giliran pemain hidup), kunci `player:<id>:lives` (sisa nyawa per pemain), dan kunci `game:timer` dengan TTL milisekon yang berfungsi sebagai *deadline* otoritatif.
- **SQLite** (`wordfuse.db` melalui `better-sqlite3`) menyimpan data persisten lintas-pertandingan: tabel `players`, `matches`, dan `match_players`. Penyimpanan satu pertandingan dibungkus dalam satu transaksi sehingga `matches` dan seluruh baris `match_players`-nya commit secara atomik.

### 3.2 Binding Antarmuka Jaringan

Server Express dan server Socket.io keduanya melakukan `listen(<port>, '0.0.0.0', ...)`. Tujuan binding ke `0.0.0.0` (alih-alih `127.0.0.1`) adalah agar kedua server menerima koneksi pada **semua** antarmuka jaringan mesin host, termasuk antarmuka WiFi/Ethernet yang menghadap LAN. Tanpa binding ini, perangkat lain di jaringan WiFi yang sama tidak akan dapat menjangkau server walaupun firewall mengizinkan.

Sebaliknya, Redis sengaja tetap pada `127.0.0.1:6379` (*loopback-only*) sehingga state internal pertandingan tidak dapat diakses langsung dari perangkat LAN lain. Hal ini sederhana namun efektif sebagai pertahanan terhadap kebocoran state internal.

### 3.3 Tabel Port

| Port | Layanan | Binding | Protokol | Keterangan |
|---|---|---|---|---|
| 3000 | Express static server | `0.0.0.0` | HTTP | Menyajikan `public/index.html`, `style.css`, `game.js` |
| 3001 | Socket.io server | `0.0.0.0` | WebSocket (fallback long-polling) | Seluruh komunikasi gameplay real-time |
| 6379 | Redis | `127.0.0.1` | Redis protocol (TCP) | Game state ephemeral + timer otoritatif |

### 3.4 Cara Perangkat LAN Terkoneksi

Perangkat lain (laptop atau smartphone) yang berada pada jaringan WiFi yang sama dengan host hanya perlu membuka browser dan menavigasi ke `http://<alamat-ip-host>:3000`. Alamat IP host dapat ditemukan dengan:

- Windows: `ipconfig` (lihat baris `IPv4 Address` pada adapter aktif).
- macOS/Linux: `ifconfig` atau `ip a`.

Browser akan memuat berkas statis dari port 3000, kemudian skrip `game.js` membuka koneksi WebSocket ke `http://<alamat-ip-host>:3001` (URL ditentukan secara dinamis dari `location.hostname`).

---

## 4. Desain Protokol Aplikasi

WordFuse mendefinisikan sebuah protokol aplikasi kustom di atas WebSocket. Karena Socket.io menyediakan abstraksi *named events*, setiap pesan berbentuk `{ event: string, payload: object }`. Berikut spesifikasi event yang sebenarnya digunakan oleh kode (`server/index.js`, `server/gameManager.js`, `public/game.js`).

### 4.1 Event Klien → Server

| Event | Payload | Keterangan |
|---|---|---|
| `join_lobby` | `{ name: string, playerId?: string }` | Pemain mendaftarkan nama tampilan. Jika `playerId` (UUID dari `localStorage`) disertakan, server menggunakannya kembali. |
| `start_game` | | Host memulai permainan. Server memverifikasi bahwa pemanggil adalah host dan ada ≥ 2 pemain *connected*. |
| `submit_word` | `{ word: string }` | Pemain aktif mengirimkan kata. Server akan diam-diam mengabaikan jika pemanggil bukan pemain aktif. |
| `rejoin` | `{ playerId: string }` | Setelah reload tab atau diskoneksi sementara, klien meminta untuk dipasangkan ulang dengan identitas pemain yang sudah ada. |
| `send_chat` | `{ message: string }` | Pemain mengirim pesan chat global. Pesan kosong, > 100 karakter, atau melebihi *rate limit* 500 ms diabaikan diam-diam. Pemain yang sudah tereliminasi tetap diizinkan mengirim. |

### 4.2 Event Server → Klien

| Event | Payload | Keterangan |
|---|---|---|
| `lobby_update` | `{ players: Array<{ id, name, isHost, connected, lives }> }` | Disiarkan setiap kali roster lobby berubah. |
| `game_started` | `{ firstPlayer: string, syllable: string, timerMs: number }` | Sinyal bahwa pertandingan baru saja dimulai. |
| `turn_start` | `{ activePlayer: string, syllable: string, timerMs: number, lives?: object }` | Disiarkan setelah giliran berpindah karena timeout/eliminasi. Saat *rejoin* di tengah pertandingan, payload juga memuat `lives` per pemain. |
| `word_accepted` | `{ word: string, player: string, nextPlayer: string, nextSyllable: string, timerMs: number }` | Kata pemain aktif valid, bom berpindah ke pemain berikutnya. |
| `word_rejected` | `{ word: string, reason: 'EMPTY' \| 'NOT_IN_DICTIONARY' \| 'MISSING_SYLLABLE' }` | Hanya dikirim ke socket pengirim. Tidak mengubah state pertandingan. |
| `life_lost` | `{ player: string, livesRemaining: number }` | Pemain kehilangan satu nyawa karena timeout. |
| `player_eliminated` | `{ player: string }` | Pemain habis nyawanya dan dikeluarkan dari urutan giliran. |
| `timer_tick` | `{ remainingMs: number }` | Disiarkan ~ setiap 200 ms berdasarkan PTTL Redis. |
| `game_over` | `{ winner: string \| null, scores: Array<{ id, name, finalRank, wordsAccepted, livesLost }> }` | Disiarkan tepat satu kali per pertandingan. |
| `chat_message` | `{ playerId: string, name: string, message: string, timestamp: number }` | Pesan chat dari pemain. `playerId === "system"` menandakan pesan sistem (mis. *"Permainan dimulai!"*, *"X telah gugur!"*) yang ditampilkan dengan gaya berbeda di klien. |
| `error` | `{ message: string }` | Pesan error ke socket tertentu (mis. nama tidak valid, bukan host). |

### 4.3 Desain Timer Server-Authoritative

Modul `server/timerManager.js` mengimplementasikan timer otoritatif. Saat sebuah giliran dimulai:

```js
// Pseudocode dari timerManager.start(durationMs, onTick, onTimeout)
await redis.set('game:timer', String(durationMs), 'PX', durationMs); // SET k v PX <ms>
intervalHandle = setInterval(async () => {
  const pttl = await redis.pttl('game:timer');
  if (pttl <= 0) { onTimeout(); clearInterval(intervalHandle); return; }
  onTick(Math.min(durationMs, Math.max(0, pttl)));
}, 200);
```

Kunci `game:timer` ditulis ke Redis dengan TTL milisekon yang sama dengan `durationMs`. Setiap 200 ms, server membaca PTTL kunci tersebut dan menyiarkan `timer_tick { remainingMs }` ke seluruh klien. Saat PTTL ≤ 0, callback `onTimeout()` di `gameManager.js` dipanggil tepat sekali untuk menjalankan alur kehilangan nyawa.

Klien browser hanya menampilkan nilai `remainingMs` dan menggunakan rasio `remainingMs / initialMs` untuk menggerakkan animasi bar timer dan kecepatan denyut bom. Klien tidak pernah menghitung waktu sendiri menggunakan `Date.now()` atau `requestAnimationFrame`. Akibatnya, sekalipun jam lokal klien digeser atau JavaScript-nya dimanipulasi, kebenaran timer tetap dipegang oleh server.

### 4.4 Alur Validasi Kata

Saat klien mengirim `submit_word { word }`, alur server adalah sebagai berikut:

1. `server/index.js` menerima event dan memanggil `gameManager.submitWord(playerId, word)`.
2. `gameManager` memverifikasi `playerId === activePlayerId` jika tidak, event diabaikan diam-diam.
3. `gameManager` memanggil `wordValidator.isValid(trimmedWord, currentSyllable)`.
4. `wordValidator` melakukan dua pemeriksaan:
   - `dictionary.has(word.trim().toLowerCase())` *lookup* O(1) ke `Set<string>` yang dimuat di memori sejak startup.
   - `word.trim().toLowerCase().includes(syllable.toLowerCase())` pengujian substring case-insensitive.
5. Jika `{ ok: true }`, server menghentikan timer aktif, menambah `round`, memilih pemain berikutnya via `advanceTurn(turnOrder, currentId)`, memilih suku kata baru via `pickSyllable(round)`, memulai timer baru, dan menyiarkan `word_accepted`.
6. Jika `{ ok: false, reason }`, server hanya mengirim `word_rejected` ke socket pengirim. State permainan tidak berubah; timer tetap berjalan.

Karena kamus berbentuk `Set` yang sudah berada di memori, biaya validasi adalah O(1) untuk dictionary lookup dan O(panjang kata) untuk substring check total tidak akan terasa oleh pemain dan tidak menambah latensi yang berarti pada round-trip.

### 4.5 Protokol Reconnection

Setiap browser klien menyimpan UUID pribadi pada `localStorage['wordfuse.playerId']`. UUID ini dihasilkan via `crypto.randomUUID()` saat pertama kali halaman dimuat. Pada setiap koneksi Socket.io baru (termasuk setelah reload tab), klien langsung mengirim:

```js
socket.emit('rejoin', { playerId });
```

Server kemudian:

1. Mencari `playerId` pada `Map<playerId, Player>` in-memory.
2. Jika ditemukan, set `connected = true` dan mengaitkan ulang socket baru ke pemain tersebut.
3. Membatalkan timer auto-forfeit 5 detik jika sedang berjalan untuk pemain ini.
4. Jika ada pertandingan yang berlangsung, mengirimkan snapshot state melalui `turn_start` ke socket itu saja (berisi `activePlayer`, `syllable`, `timerMs`, dan `lives` per pemain). Jika tidak, mengirimkan `lobby_update`.

Jika pemain aktif kebetulan mengalami diskoneksi (`socket.on('disconnect')`) di tengah giliran, server menjadwalkan auto-forfeit sebesar 5000 ms. Apabila `rejoin` datang sebelum batas tersebut, auto-forfeit dibatalkan dan pemain melanjutkan tanpa kehilangan nyawa. Apabila tidak, alur `onTimeout` yang sama dengan timer habis akan dijalankan satu kali.

---

## 5. Pengujian Performa dan Beban Server

Pengujian berikut dilakukan pada konfigurasi LAN yang tersedia: satu mesin host (Windows 11, Node.js 24, Redis berjalan di WSL) dan beberapa perangkat klien terhubung ke WiFi yang sama dengan host.

### 5.1 Skenario Pengujian

**Skenario 1 Pemain minimum.**
Dua tab browser dibuka pada mesin host (`http://localhost:3000`). Pemain bergiliran mengirimkan kata; latensi `submit_word → word_accepted` diukur menggunakan tab Network di Chrome DevTools (kolom *Time*).

**Skenario 2 Multi-perangkat.**
Tiga perangkat fisik (laptop host + 1 laptop tambahan + 1 smartphone) bergabung ke pertandingan yang sama melalui `http://<host-ip>:3000`. Sinkronisasi timer diamati dengan membandingkan tampilan teks `X.X s` pada tiga layar.

**Skenario 3 Latensi penolakan.**
Pemain aktif mengirimkan kata yang **tidak** ada dalam kamus. Waktu antara klik *Send* dan munculnya animasi *shake* diukur via DevTools.

**Skenario 4 Reconnect.**
Salah satu perangkat dimatikan WiFi-nya saat permainan berjalan, kemudian dinyalakan kembali dalam < 5 detik. Diamati apakah `rejoin` mengembalikan state dengan benar dan auto-forfeit batal dijalankan.

### 5.2 Hasil Pengukuran

| Skenario | Jumlah Pemain | Rata-rata Latensi | Hasil |
|---|---|---|---|
| 1 Pemain minimum (host saja) | 2 | ~3 – 8 ms | Bom berpindah segera; tidak ada delay yang terasa. |
| 2 Multi-perangkat LAN | 3 | ~15 – 40 ms | Timer pada ketiga layar berbeda dalam orde puluhan ms karena network jitter dan jadwal render browser. Sinkronisasi state pertandingan tetap konsisten. |
| 3 Penolakan kata | 2 | ~5 – 12 ms | Animasi *shake* dan pesan `Not in dictionary.` muncul hampir seketika. |
| 4 Reconnect dalam 5 s | 2 | | `rejoin` berhasil; pemain melanjutkan giliran tanpa kehilangan nyawa. |

### 5.3 Observasi tentang Perbedaan Tampilan Timer

Pada Skenario 2, ditemukan bahwa nilai `X.X s` di ketiga perangkat tidak selalu identik pada saat yang sama. Selisih kecil dalam orde puluhan milidetik berasal dari tiga sumber:

1. **Network jitter** paket `timer_tick` yang sama mencapai setiap perangkat pada waktu sedikit berbeda akibat antrian pada *access point* WiFi.
2. **Browser render scheduling** masing-masing browser men-update DOM pada *animation frame* terdekat, sehingga ada *quantization* tambahan ~16 ms (60 fps).
3. **`setInterval` drift** interval 200 ms server tidak presisi sempurna; bisa bergeser 5–20 ms tergantung beban event loop Node.

Karena perbedaan ini hanya bersifat tampilan (server tetap memegang sumber kebenaran via Redis TTL), tidak ada pemain yang dirugikan: yang menghitung kapan `onTimeout` dipanggil adalah server, bukan klien.

---

## 6. Hasil dan Analisis

### 6.1 Hal-hal yang Berhasil Diimplementasikan

- **Multiplayer real-time melalui LAN tanpa internet.** Setelah `redis-server` aktif dan `node server/index.js` dijalankan, perangkat manapun di WiFi yang sama dapat ikut bermain dengan membuka URL host. Tidak ada cloud, tidak ada akun.
- **Timer server-authoritative menutup celah desinkronisasi.** Dengan menulis TTL ke Redis dan membaca PTTL setiap 200 ms, server adalah satu-satunya pihak yang menentukan kapan giliran habis. Klien hanya menggambar UI berdasarkan `remainingMs` yang ia terima.
- **Validasi kata instan.** Kamus dimuat satu kali pada saat startup dari `data/words_id.json` (bersumber dari Sastrawi/KBBI dengan ekspansi afiksasi standar Bahasa Indonesia: `ber-`, `me-`, `men-`, `mem-`, `meng-`, `di-`, `ter-`, `se-`, `pe-`, `peng-`, `ke-`, suffiks `-an`, `-kan`, `-i`, `-nya`, dan konfiks gabungan), menghasilkan ~828.000 entri. `Set.has()` memberikan lookup O(1), sehingga validasi tidak menjadi *bottleneck*.
- **Difficulty scaling berfungsi sesuai desain.** Tabel `TIERS` di `server/syllableTiers.js` menerapkan: ronde 1–3 = 10000 ms dengan suku kata 2 huruf; ronde 4–6 = 8000 ms dengan suku kata 3 huruf; ronde ≥ 7 = 5000 ms dengan suku kata sulit.
- **Persistensi pertandingan ke SQLite.** Setiap pertandingan yang selesai disimpan ke `wordfuse.db` dalam satu transaksi yang menulis baris `matches` dan `playerCount` baris `match_players`. Layar hasil menampilkan ranking, jumlah kata diterima, dan jumlah nyawa hilang per pemain.
- **Antarmuka mobile-friendly.** Semua kontrol berukuran ≥ 44 px (target sentuh standar), tidak ada *horizontal scrolling* sampai lebar viewport 320 px, dan input kata dipaksa *uppercase* secara visual maupun saat dikirim agar pemain tidak ragu apakah kapitalisasi penting.

### 6.2 Analisis: WebSocket vs HTTP Polling

Permainan ini secara fundamental tidak cocok dengan model HTTP request-response biasa. Untuk menyiarkan `timer_tick` setiap 200 ms ke 6 klien, model HTTP polling akan memerlukan:

- 5 request per detik per klien × 6 klien = 30 request per detik untuk timer saja.
- Setiap request membawa *overhead* TCP handshake (atau setidaknya HTTP header yang lengkap).
- *Push* dari server tetap mustahil klien hanya akan menerima *update* saat ia bertanya, bukan saat server punya berita.

WebSocket (yang merupakan transport utama Socket.io di project ini) menyelesaikan masalah tersebut dengan mempertahankan satu koneksi TCP persisten per klien. Setelah *upgrade handshake*, server dapat melakukan `io.emit(...)` kapan saja dan pesan langsung sampai. *Overhead* per pesan hanya beberapa byte *frame header*. Latensi *push* turun dari ratusan milidetik (HTTP polling worst case) menjadi puluhan milidetik. Tanpa WebSocket, mekanika "bom yang berdenyut" pada WordFuse tidak akan terasa real-time.

### 6.3 Analisis: Mengapa Redis untuk State Sementara dan SQLite untuk State Persisten

Pemilihan dua *backend storage* yang berbeda sengaja menyesuaikan pola akses masing-masing:

**State pertandingan yang sedang berlangsung** (siapa giliran, suku kata aktif, sisa waktu, sisa nyawa) memiliki karakteristik:

- *High write frequency* timer ditulis sekali per giliran lalu dibaca 5× per detik; nyawa pemain berubah pada setiap timeout.
- *Short-lived* semua state ini relevan hanya selama pertandingan berlangsung dan tidak perlu bertahan setelahnya.
- *Need TTL semantics* `game:timer` adalah *deadline* yang otomatis berakhir, persis seperti yang diberikan Redis melalui PEXPIRE.

Redis sebagai database in-memory dengan TTL bawaan adalah pilihan yang tepat. Tidak ada manfaat dari menyimpan timer ke disk; sebaliknya, persistensi disk akan menambah latensi yang tidak perlu.

**State riwayat pertandingan** (siapa menang, statistik per pemain) memiliki karakteristik berkebalikan:

- *Low write frequency* hanya satu transaksi per pertandingan selesai.
- *Long-lived* perlu bertahan setelah server restart agar leaderboard tetap utuh.
- *Need relational queries* leaderboard membutuhkan query JOIN antara `players` dan `match_players`.

SQLite (melalui `better-sqlite3`) memberikan persistensi disk, transaksi ACID, dan SQL relasional dengan jejak operasional minimal hanya satu *file*, tidak butuh server terpisah. Pemisahan ini juga merupakan contoh penerapan prinsip *right tool for the job* dalam desain sistem.

### 6.4 Analisis: Chat Global dan UI Konfirmasi Tanpa Beban Server Tambahan

Fitur chat global serta seluruh notifikasi visual (toast, banner, animasi bom, konfeti kemenangan) sengaja dirancang agar **menggunakan kembali koneksi WebSocket yang sudah ada**, tanpa membuka koneksi tambahan. Pesan chat berbagi kanal yang sama dengan event gameplay (`turn_start`, `timer_tick`, dll.); satu-satunya tambahan adalah dua nama event baru: `send_chat` (klien → server) dan `chat_message` (server → klien). Pesan chat diteruskan dengan *broadcast* ringan, dilengkapi *rate limiting* sederhana di sisi server (peta `Map<playerId, lastChatTime>` dengan jeda minimum 500 ms dan batas 100 karakter per pesan) yang menjadi pertahanan terhadap *flood*.

Seluruh sistem **konfirmasi UI bersifat klien-side**: ketika klien menerima `word_accepted`, `life_lost`, `player_eliminated`, atau `game_over`, ia memicu animasi CSS berbasis *keyframes* untuk menampilkan toast hijau, banner merah penuh-lebar, animasi bom yang berpindah antar kartu pemain, hingga konfeti kemenangan semuanya tanpa memuat satu byte tambahan dari server. Akibatnya, beban server akibat penambahan fitur ini mendekati nol; server hanya menambah satu pesan chat dan satu *Map* in-memory, sementara seluruh kerja animasi dialihkan ke GPU browser masing-masing pemain.

---

## 7. Kendala dan Solusi

| Kendala | Solusi |
|---|---|
| Firewall Windows ngeblok koneksi LAN ke port 3000/3001 perangkat lain tidak bisa konek ke host. | Tambah inbound rule di Windows Firewall untuk TCP port 3000 dan 3001, profil Private Network. |
| Timer di beberapa perangkat tampak tidak sinkron (selisih puluhan milidetik). | Ini hanya masalah tampilan. Timer dikelola sepenuhnya di server via Redis TTL yang menentukan kapan giliran habis tetap server, bukan klien. |
| Kalau pemain aktif disconnect di tengah giliran, game macet nunggu submit yang tidak pernah datang. | Auto-forfeit: saat socket pemain aktif disconnect, server jadwalkan `setTimeout(5000)` yang trigger alur life-lost. Kalau `rejoin` datang sebelum 5 detik, timer batal. |
| Validasi kata tidak boleh lambat karena timer terus jalan. | Kamus dimuat sekali waktu startup ke `Set<string>` `dictionary.has(word)` adalah O(1), total validasi per submit < 1 ms. |
| Beberapa browser mobile atau jaringan tertentu blokir WebSocket upgrade. | Socket.io punya fallback ke long-polling otomatis. Konfigurasi `transports: ['websocket', 'polling']` dibiarkan aktif di kedua sisi. |
| KBBI cuma menyediakan kata dasar bentuk berimbuhan seperti `makanan`, `memakan`, `dimakan` awalnya ditolak. | `scripts/build_dictionary.js` ambil ~30 ribu akar dari Sastrawi lalu ekspansi dengan prefiks (`ber-`, `me-`, `men-`, `di-`, `ter-`, dll.) dan sufiks (`-an`, `-kan`, `-i`, `-nya`). Hasilnya ~828 ribu entri di `words_id.json`. |
| Pemain bingung apakah huruf besar/kecil penting karena suku kata ditampilkan kapital tapi keyboard mobile kirim huruf kecil. | Validator case-insensitive dari awal. Biar jelas ke pemain, input dipaksa kapital lewat dua lapis: `text-transform: uppercase` di CSS dan `toUpperCase()` di event `input` pada `game.js`. |
| Chat bisa di-spam dan ganggu server. | Rate limit sederhana: pesan dari `playerId` yang sama dalam < 500 ms diabaikan, pesan > 100 karakter ditolak. Cukup satu `Map<playerId, timestamp>` in-memory, tidak butuh modul tambahan. |
| Terlalu banyak notifikasi sekaligus bisa nutupin input kata. | Toast stack dibatasi maksimal 3 yang terlama otomatis tergantikan. Posisinya di top-center dan tidak menghalangi input di ukuran layar apapun. |

---

## 8. Kesimpulan dan Saran

### 8.1 Kesimpulan

WordFuse berhasil dijalankan sebagai game multiplayer real-time berbasis LAN 2 sampai 6 pemain bisa main dari browser apa pun di WiFi yang sama, tanpa instalasi apapun di sisi klien dan tanpa koneksi internet.

Secara arsitektur, pendekatan klien–server terbukti bekerja dengan baik untuk skenario ini. Klien hanya mengirim intent (`submit_word`) dan menampilkan state yang diterima dari server tidak ada logika permainan di sisi klien yang bisa dimanipulasi.

Timer server-authoritative via Redis TTL menyelesaikan masalah desinkronisasi. Karena klien tidak pernah menghitung waktu sendiri, selisih tampilan antar perangkat hanya bersifat kosmetik dan tidak mempengaruhi keadilan permainan.

Pemisahan Redis dan SQLite juga terasa tepat setelah diimplementasikan. Redis untuk state yang hidup cuma selama pertandingan dan butuh TTL; SQLite untuk hasil yang perlu bertahan dan bisa di-query secara relasional. Keduanya saling melengkapi tanpa tumpang tindih.

Satu hal yang cukup berhasil dari sisi pengalaman pemain adalah penanganan diskoneksi kombinasi UUID di `localStorage`, event `rejoin`, dan auto-forfeit 5 detik membuat pemain yang WiFi-nya sesaat putus tidak langsung kalah.

### 8.2 Saran untuk Pengembangan Selanjutnya

Kalau project ini dilanjutkan, ada beberapa arah yang menarik:

- Saat ini server hanya menampung satu pertandingan global. Menambahkan konsep `roomId` dengan Socket.io namespace memungkinkan beberapa grup main di server yang sama secara bersamaan.
- Untuk bisa dimainkan lintas-jaringan (bukan cuma LAN), butuh deployment ke layanan seperti Railway atau Render. Tidak perlu banyak perubahan arsitektur cukup tambah Dockerfile dan pindahkan konfigurasi Redis ke environment variable.
- Kamus sudah ~828 ribu entri, tapi ekspansi afiksasi dilakukan secara mekanis. Beberapa bentuk yang tergenerate mungkin tidak benar-benar terpakai dalam Bahasa Indonesia sehari-hari. Validasi ulang terhadap KBBI online bisa meningkatkan kualitasnya.
- Tabel `match_players` sudah menyimpan `final_rank` per pertandingan. Tinggal tambah kolom `elo` di tabel `players` dan update tiap game selesai untuk punya leaderboard kompetitif jangka panjang.
- Untuk chat, satu tambahan ringan yang menarik adalah emoji reactions cukup satu event `chat_react { messageId, emoji }` tanpa perlu banyak perubahan di sisi server.

---

## 9. Lampiran: Cara Menjalankan Aplikasi

### 9.1 Prasyarat

- Node.js ≥ 18 (diuji pada Node 24).
- `redis-server` yang dapat dihubungi pada `127.0.0.1:6379`. Pada Windows, opsi yang umum adalah menjalankan Redis di dalam WSL atau memasang Memurai secara native.
- `sudo service redis-server start' Jalankan command ini di WSL terlebih dahulu (Install jika belum ada)`

### 9.2 Langkah Menjalankan

```bash
# 1. Pasang dependensi Node (sekali per checkout)
npm install

# 2. Pastikan Redis berjalan di loopback (Run command ini di terminal)
redis-cli ping     # harus mengembalikan "PONG"

# 3. Jalankan server WordFuse (Run command ini di terminal)
node server/index.js
# atau
npm start
```

Output startup yang diharapkan:

```
[startup] dictionary loaded: 828136 entries
[startup] redis OK (PING -> PONG)
[startup] static server on http://0.0.0.0:3000 (public/)
[startup] socket.io server on http://0.0.0.0:3001
[startup] WordFuse ready. Open http://localhost:3000
```

### 9.3 Mengakses Permainan

- **Mesin host:** buka `http://localhost:3000` di browser apa pun.
- **Perangkat lain di WiFi yang sama:** buka `http://<alamat-ip-host>:3000`.

Cara mendapatkan alamat IP host:

| Sistem Operasi | Perintah |
|---|---|
| Windows | `ipconfig` (lihat baris `IPv4 Address` pada adapter aktif) |
| macOS / Linux | `ifconfig` atau `ip a` |

Jika perangkat lain tidak dapat terkoneksi, periksa pengaturan firewall pada mesin host dan pastikan port TCP 3000 dan 3001 diperbolehkan untuk *Private Network*.

Run Command ini di windows powershell dengan login admin untuk menembus firewall:
- `New-NetFirewallRule -DisplayName "WordFuse 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private`
- `New-NetFirewallRule -DisplayName "WordFuse 3001" -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow -Profile Private`

### 9.4 Menjalankan Test Suite

Property-based test menggunakan `node --test` dan `fast-check`:

```bash
npm test
```

Test mencakup validator kata, pemilihan suku kata per *tier*, rotasi urutan giliran, *no-op* untuk submisi dari pemain non-aktif, monotonisitas nyawa, dan jaminan satu `game_over` per pertandingan.

### 9.5 Struktur Repositori

```
server/                Node.js Socket.io game server
  index.js             Entry point (Express :3000 + Socket.io :3001)
  gameManager.js       Lobby, urutan giliran, nyawa, persistensi
  wordValidator.js     Fungsi validasi kata (pure function)
  syllableTiers.js     Tabel tier + pickSyllable / timerForRound
  timerManager.js      Countdown server-authoritative via Redis TTL
  redisClient.js       Singleton ioredis (loopback only)
  db.js                Skema dan query better-sqlite3
public/                Frontend vanilla HTML/CSS/JS
  index.html           Single-page shell tiga screen
  style.css            Dark theme, animasi bom, ikon nyawa
  game.js              Klien Socket.io + DOM updates
data/
  words_id.json        Daftar kata Bahasa Indonesia (~828k entri)
  kata-dasar.txt       Akar kata KBBI dari Sastrawi (~30k entri)
scripts/
  build_dictionary.js  Generator yang menghasilkan words_id.json
test/                  Property-based tests (node --test + fast-check)
.kiro/specs/wordfuse/  Dokumen spec (design, requirements, tasks)
```

---

*Dokumen ini ditulis sebagai laporan akhir Final Project mata kuliah Jaringan Komputer di Institut Teknologi Sepuluh Nopember (ITS).*
