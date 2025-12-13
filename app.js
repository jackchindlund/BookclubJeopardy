/* app.js
   Single-page Jeopardy (Host + Players) using Firebase Realtime Database.

   Spec implemented:
   - Host creates room code, loads questions.json, renders 5x5 board
   - Clicking a tile opens center modal (question), starts 20s timer, enables buzz
   - First buzz wins (transaction)
   - Tap clue to reveal answer (flip)
   - Host awards/penalizes points
   - Return to board marks clue used, clears active state, disables buzz
*/

(() => {
  // -----------------------------
  // Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  function randomCode() {
    const n = Math.floor(1000 + Math.random() * 9000);
    return `JEP-${n}`;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function uid() {
    // stable per device/browser
    const key = "jeop_player_id";
    let v = localStorage.getItem(key);
    if (!v) {
      v = "p_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      localStorage.setItem(key, v);
    }
    return v;
  }

  // -----------------------------
  // Firebase init
  // -----------------------------
  if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey) {
    alert("Missing Firebase config. Paste config into firebase-config.js");
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  const db = firebase.database();

  // server time offset for synchronized timer display
  let serverOffsetMs = 0;
  db.ref(".info/serverTimeOffset").on("value", (snap) => {
    serverOffsetMs = snap.val() || 0;
  });

  function nowServerMs() {
    return Date.now() + serverOffsetMs;
  }

  // -----------------------------
  // UI Screens
  // -----------------------------
  const screenLanding = $("screenLanding");
  const screenHostSetup = $("screenHostSetup");
  const screenJoinSetup = $("screenJoinSetup");
  const screenHostGame = $("screenHostGame");
  const screenPlayerGame = $("screenPlayerGame");

  function showScreen(screenEl) {
    [screenLanding, screenHostSetup, screenJoinSetup, screenHostGame, screenPlayerGame].forEach(s => {
      s.hidden = s !== screenEl;
    });
  }

  // Top pill
  const roomPill = $("roomPill");
  const roomCodeText = $("roomCodeText");
  function setRoomPill(code) {
    if (!code) {
      roomPill.hidden = true;
      roomCodeText.textContent = "----";
    } else {
      roomPill.hidden = false;
      roomCodeText.textContent = code;
    }
  }

  // -----------------------------
  // App state
  // -----------------------------
  const appState = {
    mode: null, // "host" | "player"
    roomCode: null,
    teamId: null, // "team1" | "team2"
    playerName: null,

    questions: null, // loaded JSON
    boardIndex: null, // for quick lookup
    roomRef: null,
    unsub: [],

    // live room data
    roomData: null,

    // current clue
    activeClueKey: null, // "c0_v100" etc
    activeClue: null
  };

  function clearListeners() {
    appState.unsub.forEach(fn => {
      try { fn(); } catch {}
    });
    appState.unsub = [];
  }

  // -----------------------------
  // Load questions.json
  // -----------------------------
  async function loadQuestions() {
    const res = await fetch("questions.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load questions.json");
    const data = await res.json();

    // Validate minimal structure
    if (!data.categories || data.categories.length !== 5) {
      throw new Error("questions.json must contain exactly 5 categories");
    }
    for (const c of data.categories) {
      if (!c.title || !Array.isArray(c.clues) || c.clues.length !== 5) {
        throw new Error("Each category must have a title and exactly 5 clues");
      }
      const values = c.clues.map(x => x.value).sort((a,b)=>a-b).join(",");
      if (values !== "100,200,300,400,500") {
        throw new Error("Each category must have clue values 100,200,300,400,500");
      }
      for (const clue of c.clues) {
        if (!clue.question || !clue.answer) throw new Error("Each clue needs question and answer");
      }
    }
    return data;
  }

  function buildBoardIndex(questions) {
    // key format: c{catIndex}_v{value}
    const map = new Map();
    questions.categories.forEach((cat, ci) => {
      cat.clues.forEach((clue) => {
        const key = `c${ci}_v${clue.value}`;
        map.set(key, { ci, ...clue, categoryTitle: cat.title });
      });
    });
    return map;
  }

  // -----------------------------
  // Room schema
  // -----------------------------
  function roomPath(code) {
    return `rooms/${code}`;
  }

  function makeInitialBoardState() {
    // Store used flags only (question/answer live in JSON, not in DB)
    const used = {};
    for (let ci=0; ci<5; ci++) {
      for (const v of [100,200,300,400,500]) {
        used[`c${ci}_v${v}`] = false;
      }
    }
    return used;
  }

  async function createRoomAsHost() {
    const questions = await loadQuestions();
    const code = randomCode();

    // Build initial state
    const initial = {
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      phase: "board", // "board" | "question" | "answer"
      activeClueKey: null,
      teams: {
        team1: { name: "Team 1", score: 0 },
        team2: { name: "Team 2", score: 0 }
      },
      buzz: {
        firstBuzzTeam: null,
        firstBuzzAt: null
      },
      timer: {
        durationSec: 20,
        endAtMs: null
      },
      boardUsed: makeInitialBoardState()
    };

    // Write to DB
    await db.ref(roomPath(code)).set(initial);

    // Store locally
    appState.mode = "host";
    appState.roomCode = code;
    appState.questions = questions;
    appState.boardIndex = buildBoardIndex(questions);
    appState.roomRef = db.ref(roomPath(code));

    // Host UI
    $("hostRoomCode").textContent = code;
    setRoomPill(code);

    // Move into host game view and subscribe
    showScreen(screenHostGame);
    renderBoard();
    subscribeToRoom();
  }

  // -----------------------------
  // Join as player
  // -----------------------------
  async function joinRoomAsPlayer(code, teamId, playerName) {
    const ref = db.ref(roomPath(code));
    const snap = await ref.get();
    if (!snap.exists()) throw new Error("Room not found. Check the code.");

    appState.mode = "player";
    appState.roomCode = code;
    appState.teamId = teamId;
    appState.playerName = playerName || "Player";
    appState.roomRef = ref;

    // register player presence (simple)
    const playerId = uid();
    await ref.child(`players/${playerId}`).set({
      name: appState.playerName,
      teamId,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });

    setRoomPill(code);

    // Player UI
    $("playerRoomCode").textContent = code;
    $("playerTeamTag").textContent = teamId === "team1" ? "TEAM 1" : "TEAM 2";

    showScreen(screenPlayerGame);
    subscribeToRoom();
  }

  // -----------------------------
  // Subscribe to room updates
  // -----------------------------
  function subscribeToRoom() {
    clearListeners();

    const ref = appState.roomRef;
    if (!ref) return;

    const handler = (snap) => {
      appState.roomData = snap.val();
      if (!appState.roomData) return;
      updateAllUI();
    };

    ref.on("value", handler);
    appState.unsub.push(() => ref.off("value", handler));
  }

  // -----------------------------
  // Rendering board (host)
  // -----------------------------
  const boardEl = $("board");

  function renderBoard() {
    if (!appState.questions) return;

    boardEl.innerHTML = "";

    // Row 1: categories
    appState.questions.categories.forEach((cat) => {
      const div = document.createElement("div");
      div.className = "cat";
      div.textContent = cat.title;
      boardEl.appendChild(div);
    });

    // 5 rows of values
    for (const v of [100,200,300,400,500]) {
      for (let ci=0; ci<5; ci++) {
        const key = `c${ci}_v${v}`;
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.dataset.key = key;
        tile.textContent = `$${v}`;
        tile.addEventListener("click", () => onHostTileClick(key));
        boardEl.appendChild(tile);
      }
    }
  }

  function updateBoardUsedUI() {
    if (!appState.roomData || appState.mode !== "host") return;
    const used = appState.roomData.boardUsed || {};
    document.querySelectorAll(".tile").forEach(tile => {
      const key = tile.dataset.key;
      if (!key) return;
      const isUsed = !!used[key];
      tile.classList.toggle("used", isUsed);
    });
  }

  // -----------------------------
  // Host tile click -> open clue
  // -----------------------------
  async function onHostTileClick(clueKey) {
    const room = appState.roomData;
    if (!room) return;

    // ignore used tiles
    if (room.boardUsed && room.boardUsed[clueKey]) return;

    // prevent opening if already in an active clue
    if (room.phase !== "board") return;

    const clue = appState.boardIndex.get(clueKey);
    if (!clue) return;

    // Set phase question, set active clue, start timer
    const endAt = nowServerMs() + (room.timer?.durationSec ?? 20) * 1000;

    await appState.roomRef.update({
      phase: "question",
      activeClueKey: clueKey,
      "buzz/firstBuzzTeam": null,
      "buzz/firstBuzzAt": null,
      "timer/endAtMs": endAt
    });

    // open modal (local)
    openClueModal(clueKey, "question");
  }

  // -----------------------------
  // Timer UI loop
  // -----------------------------
  let timerInterval = null;

  function ensureTimerLoop() {
    if (timerInterval) return;
    timerInterval = setInterval(() => {
      updateTimerUI();
      updatePlayerBuzzButton();
    }, 120);
  }

  function updateTimerUI() {
    const room = appState.roomData;
    const endAt = room?.timer?.endAtMs;
    const duration = room?.timer?.durationSec ?? 20;

    let remaining = duration;
    if (endAt) {
      remaining = Math.ceil((endAt - nowServerMs()) / 1000);
      remaining = clamp(remaining, 0, 999);
    }

    // Host timer
    if ($("timerValue")) $("timerValue").textContent = String(remaining);
    // Player timer
    if ($("pTimerValue")) $("pTimerValue").textContent = String(remaining);

    // Update hint color (optional)
  }

  // -----------------------------
  // Buzz logic (player)
  // -----------------------------
  async function playerBuzz() {
    const room = appState.roomData;
    if (!room) return;

    // Only if question phase, timer > 0, no buzz yet
    if (room.phase !== "question") return;

    const endAt = room.timer?.endAtMs;
    if (!endAt || nowServerMs() >= endAt) return;

    // Use transaction to ensure "first buzz wins"
    const buzzRef = appState.roomRef.child("buzz");
    await buzzRef.transaction((current) => {
      if (!current) current = {};
      if (current.firstBuzzTeam) return; // already set
      return {
        firstBuzzTeam: appState.teamId,
        firstBuzzAt: firebase.database.ServerValue.TIMESTAMP
      };
    });
  }

  function updatePlayerBuzzButton() {
    if (appState.mode !== "player") return;
    const room = appState.roomData;
    const btn = $("btnBuzz");
    if (!btn || !room) return;

    const endAt = room.timer?.endAtMs;
    const inTime = endAt && nowServerMs() < endAt;
    const nobodyBuzzed = !room.buzz?.firstBuzzTeam;

    const enabled = (room.phase === "question") && inTime && nobodyBuzzed;
    btn.disabled = !enabled;

    if (room.phase !== "question") {
      $("pBuzzText").textContent = "Waiting for question…";
    } else if (!inTime) {
      $("pBuzzText").textContent = "Time’s up.";
    } else if (!nobodyBuzzed) {
      const t = room.buzz.firstBuzzTeam === "team1" ? (room.teams?.team1?.name || "Team 1") : (room.teams?.team2?.name || "Team 2");
      $("pBuzzText").textContent = `${t} buzzed first.`;
    } else {
      $("pBuzzText").textContent = "Buzz is open!";
    }
  }

  // -----------------------------
  // Host controls
  // -----------------------------
  async function resetBuzz() {
    if (appState.mode !== "host") return;
    await appState.roomRef.update({
      "buzz/firstBuzzTeam": null,
      "buzz/firstBuzzAt": null
    });
  }

  async function resetTimer() {
    if (appState.mode !== "host") return;
    const room = appState.roomData;
    const duration = room?.timer?.durationSec ?? 20;

    if (room.phase === "question") {
      const endAt = nowServerMs() + duration * 1000;
      await appState.roomRef.update({ "timer/endAtMs": endAt });
    } else {
      // If not in question, just clear timer display
      await appState.roomRef.update({ "timer/endAtMs": null });
    }
  }

  async function adjustScore(teamId, delta) {
    if (appState.mode !== "host") return;

    const scoreRef = appState.roomRef.child(`teams/${teamId}/score`);
    await scoreRef.transaction((cur) => (cur || 0) + delta);
  }

  async function endRoom() {
    if (!appState.roomRef) return;
    // For simplicity, just delete the room node
    await appState.roomRef.remove();
    leaveToLanding();
  }

  // -----------------------------
  // Clue modal (host only)
  // -----------------------------
  const clueModal = $("clueModal");
  const clueInner = $("clueInner");
  const clueMeta = $("clueMeta");
  const cluePhase = $("cluePhase");
  const clueText = $("clueText");
  const ansMeta = $("ansMeta");
  const ansText = $("ansText");

  function openClueModal(clueKey, phase) {
  // HARD GUARD: never open modal unless host with active room
  if (
    appState.mode !== "host" ||
    !appState.roomData ||
    !appState.roomData.activeClueKey
  ) {
    return;
  

    appState.activeClueKey = clueKey;
    appState.activeClue = clue;

    clueMeta.textContent = `${clue.categoryTitle} • $${clue.value}`;
    ansMeta.textContent = `${clue.categoryTitle} • $${clue.value}`;

    cluePhase.textContent = "QUESTION";
    clueText.textContent = clue.question;
    ansText.textContent = clue.answer;

    clueInner.classList.remove("flipped");
    clueModal.hidden = false;

    // Clicking the card flips to answer (host)
    $("clueCard").onclick = async () => {
      if (appState.mode !== "host") return;
      const room = appState.roomData;
      if (!room) return;

      // Only allow flip if in question phase (or already answer)
      if (room.phase === "question") {
        // set DB phase to answer, flip UI
        await appState.roomRef.update({ phase: "answer" });
        clueInner.classList.add("flipped");
      }
    };

    // Overlay click does nothing until answer is shown; return button closes.
    $("modalOverlay").onclick = () => {
      // do nothing (keeps it controlled)
    };
  }

  function closeClueModal() {
    clueModal.hidden = true;
    appState.activeClueKey = null;
    appState.activeClue = null;
    clueInner.classList.remove("flipped");
  }

  async function returnToBoardAndMarkUsed() {
    if (appState.mode !== "host") return;
    const room = appState.roomData;
    const key = room?.activeClueKey;
    if (!key) return;

    const updates = {};
    updates[`boardUsed/${key}`] = true;
    updates["phase"] = "board";
    updates["activeClueKey"] = null;
    updates["timer/endAtMs"] = null;
    updates["buzz/firstBuzzTeam"] = null;
    updates["buzz/firstBuzzAt"] = null;

    await appState.roomRef.update(updates);
    closeClueModal();
  }

  // -----------------------------
  // UI updates from room state
  // -----------------------------
  function updateAllUI() {
    ensureTimerLoop();

    const room = appState.roomData;
    if (!room) return;

    // Team names/scores
    const t1n = room.teams?.team1?.name || "Team 1";
    const t2n = room.teams?.team2?.name || "Team 2";
    const t1s = room.teams?.team1?.score ?? 0;
    const t2s = room.teams?.team2?.score ?? 0;

    $("team1Label") && ($("team1Label").textContent = t1n);
    $("team2Label") && ($("team2Label").textContent = t2n);
    $("team1Score") && ($("team1Score").textContent = String(t1s));
    $("team2Score") && ($("team2Score").textContent = String(t2s));

    $("pTeam1Label") && ($("pTeam1Label").textContent = t1n);
    $("pTeam2Label") && ($("pTeam2Label").textContent = t2n);
    $("pTeam1Score") && ($("pTeam1Score").textContent = String(t1s));
    $("pTeam2Score") && ($("pTeam2Score").textContent = String(t2s));

    // Buzz display
    const buzzTeam = room.buzz?.firstBuzzTeam;
    if (!buzzTeam) {
      $("buzzText") && ($("buzzText").textContent = "—");
    } else {
      const label = buzzTeam === "team1" ? t1n : t2n;
      $("buzzText") && ($("buzzText").textContent = `${label} buzzed first`);
    }

    // Update board used UI
    updateBoardUsedUI();

    // If host and DB says we're in an active clue, ensure modal is open
    if (appState.mode === "host") {
      const active = room.activeClueKey;
      if (room.phase !== "board" && active) {
        const clue = appState.boardIndex?.get(active);
        if (clue && clueModal.hidden) {
          // open in correct face
          openClueModal(active, room.phase);
          if (room.phase === "answer") clueInner.classList.add("flipped");
        } else if (!clueModal.hidden) {
          // keep in sync
          if (room.phase === "answer") clueInner.classList.add("flipped");
        }
      }
      if (room.phase === "board" && !clueModal.hidden) {
        // host forced back to board (in case refresh)
        closeClueModal();
      }
    }

    // Player buzz button
    updatePlayerBuzzButton();
  }

  // -----------------------------
  // Navigation / Buttons
  // -----------------------------
  $("btnGoHost").addEventListener("click", () => {
    showScreen(screenHostSetup);
    setRoomPill(null);
  });

  $("btnGoJoin").addEventListener("click", () => {
    showScreen(screenJoinSetup);
    setRoomPill(null);
  });

  $("btnBackFromHostSetup").addEventListener("click", () => {
    showScreen(screenLanding);
  });

  $("btnBackFromJoinSetup").addEventListener("click", () => {
    showScreen(screenLanding);
    $("joinError").hidden = true;
  });

  $("btnCreateRoom").addEventListener("click", async () => {
    try {
      $("btnCreateRoom").disabled = true;
      await createRoomAsHost();
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      $("btnCreateRoom").disabled = false;
    }
  });

  // Join selections
  let selectedTeam = null;
  function updateJoinButtonState() {
    const code = $("joinRoomCode").value.trim();
    const name = $("joinPlayerName").value.trim();
    $("btnJoinRoom").disabled = !(code && name && selectedTeam);
  }

  $("joinRoomCode").addEventListener("input", updateJoinButtonState);
  $("joinPlayerName").addEventListener("input", updateJoinButtonState);

  $("btnPickTeam1").addEventListener("click", () => {
    selectedTeam = "team1";
    $("teamPickNote").textContent = "Selected: Team 1";
    updateJoinButtonState();
  });

  $("btnPickTeam2").addEventListener("click", () => {
    selectedTeam = "team2";
    $("teamPickNote").textContent = "Selected: Team 2";
    updateJoinButtonState();
  });

  $("btnJoinRoom").addEventListener("click", async () => {
    const code = $("joinRoomCode").value.trim().toUpperCase();
    const name = $("joinPlayerName").value.trim();
    $("joinError").hidden = true;

    try {
      $("btnJoinRoom").disabled = true;
      await joinRoomAsPlayer(code, selectedTeam, name);
    } catch (e) {
      $("joinError").hidden = false;
      $("joinError").textContent = e.message || String(e);
    } finally {
      $("btnJoinRoom").disabled = false;
    }
  });

  // Player actions
  $("btnBuzz").addEventListener("click", async () => {
    try {
      await playerBuzz();
    } catch (e) {
      $("playerError").hidden = false;
      $("playerError").textContent = e.message || String(e);
    }
  });

  $("btnLeaveRoom").addEventListener("click", () => {
    leaveToLanding();
  });

  // Host actions
  $("btnResetBuzz").addEventListener("click", resetBuzz);
  $("btnTimerReset").addEventListener("click", resetTimer);
  $("btnHostEndRoom").addEventListener("click", endRoom);

  // Modal scoring actions (host)
  $("btnAwardT1").addEventListener("click", () => {
    const v = appState.activeClue?.value ?? 0;
    adjustScore("team1", v);
  });
  $("btnAwardT2").addEventListener("click", () => {
    const v = appState.activeClue?.value ?? 0;
    adjustScore("team2", v);
  });
  $("btnPenaltyT1").addEventListener("click", () => {
    const v = appState.activeClue?.value ?? 0;
    adjustScore("team1", -v);
  });
  $("btnPenaltyT2").addEventListener("click", () => {
    const v = appState.activeClue?.value ?? 0;
    adjustScore("team2", -v);
  });

  $("btnReturnToBoard").addEventListener("click", returnToBoardAndMarkUsed);

  // -----------------------------
  // Leave / reset app
  // -----------------------------
  function leaveToLanding() {
    clearListeners();
    appState.mode = null;
    appState.roomCode = null;
    appState.teamId = null;
    appState.playerName = null;
    appState.roomRef = null;
    appState.roomData = null;
    appState.questions = null;
    appState.boardIndex = null;
    closeClueModal();

    setRoomPill(null);
    $("hostRoomCode").textContent = "----";
    $("playerRoomCode").textContent = "----";
    $("playerTeamTag").textContent = "—";
    $("joinRoomCode").value = "";
    $("joinPlayerName").value = "";
    selectedTeam = null;
    $("teamPickNote").textContent = "No team selected yet.";

    showScreen(screenLanding);
  }

  // Start on landing
  showScreen(screenLanding);
})();
