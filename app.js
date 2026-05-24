/* ==========================================================================
   Golf Coach Dashboard Engine (app.js)
   Core Business Logic, Mathematical Engines & View Managers
   ========================================================================== */

// Global State
let db = null;
let currentTeam = "Varsity"; // "Varsity" or "JV"
let activeTab = "dashboard"; // "dashboard", "schedule", "roster", "metrics", "match-scoreboard", "player-profile"
let currentMatchId = null;   // Active match displayed in scoreboard view
let currentPlayerId = null;  // Active player displayed in player profile view
let currentProfileMatchId = null; // Active match ID for the player profile view (if single match mode)
let previousTab = "dashboard"; // Tab navigation tracker
let sparklineCache = {};

// Default Course Par Definition
const DEFAULT_COURSE_PARS = [4, 3, 5, 4, 4, 3, 4, 4, 5]; // Par 36 standard (Par 72 overall)

// --------------------------------------------------------------------------
// Database Management
// --------------------------------------------------------------------------
function initDatabase() {
  const saved = localStorage.getItem("golf_coach_app_db");
  if (saved) {
    try {
      db = JSON.parse(saved);
      // Auto-migrate to detailed 9-hole/18-hole and status database if loading older version
      const m1 = db.matches.find(m => m.id === "m1");
      const m8 = db.matches.find(m => m.id === "m8");
      if (!m1 || !m1.status || (m8 && (!m8.coursePars || !m8.scores["p1"].holes))) {
        console.log("Upgrading local database to support detailed scores and statuses...");
        db = JSON.parse(JSON.stringify(INITIAL_GOLF_DB));
        saveDatabase();
      }
      if (!db.players || !db.matches) {
        throw new Error("Invalid DB format");
      }
    } catch (e) {
      console.warn("LocalStorage database was corrupted, resetting to defaults", e);
      db = JSON.parse(JSON.stringify(INITIAL_GOLF_DB));
      saveDatabase();
    }
  } else {
    db = JSON.parse(JSON.stringify(INITIAL_GOLF_DB));
    saveDatabase();
  }
}

function saveDatabase() {
  localStorage.setItem("golf_coach_app_db", JSON.stringify(db));
}

function exportDatabase() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(db, null, 2));
  const downloadAnchor = document.createElement("a");
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `golf_coach_database_${currentTeam}_${new Date().toISOString().slice(0,10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

function importDatabase(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.players && imported.matches) {
        db = imported;
        saveDatabase();
        showNotification("Database successfully imported!", "success");
        renderActiveView();
      } else {
        showNotification("Failed to import: Invalid file format.", "danger");
      }
    } catch (err) {
      showNotification("Failed to import: Invalid JSON file.", "danger");
    }
  };
  reader.readAsText(file);
}

function resetDatabase() {
  if (confirm("Are you sure you want to reset the database? All custom schedules, matches, and players will be replaced with initial default data!")) {
    db = JSON.parse(JSON.stringify(INITIAL_GOLF_DB));
    saveDatabase();
    showNotification("Database reset to initial defaults.", "success");
    renderActiveView();
  }
}

// --------------------------------------------------------------------------
// Mathematics & Scoring Formulas
// --------------------------------------------------------------------------

/**
 * Calculates standard deviation (consistency rating) using the sample formula (n-1).
 */
function calculateStandardDeviation(scores) {
  if (scores.length <= 1) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const varianceSum = scores.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0);
  const stdDev = Math.sqrt(varianceSum / (scores.length - 1));
  return parseFloat(stdDev.toFixed(1));
}

/**
 * Maps standard deviation into coach consistency classification
 */
function getConsistencyLabel(stdDev, roundsCount) {
  if (roundsCount < 2) return "Insuff. Rounds";
  if (stdDev < 1.0) return "Extremely Steady";
  if (stdDev < 4.0) return "Reliable";
  if (stdDev < 6.0) return "Average";
  return "High Variance";
}

/**
 * Maps standard deviation into CSS color classes
 */
function getConsistencyClass(label) {
  switch (label) {
    case "Extremely Steady": return "consistency-steady";
    case "Reliable": return "consistency-reliable";
    case "Average": return "consistency-average";
    case "High Variance": return "consistency-high";
    default: return "badge-rank";
  }
}

/**
 * Computes all player metrics based on their historical rounds.
 * Seamlessly integrates hole-by-hole aggregation of advanced stats.
 */
function getPlayerPerformanceMetrics(player, matches) {
  const playerScores = [];
  const detailedRounds = [];
  
  let totalStrokes = 0;
  let total9HoleBlocks = 0;
  
  matches.forEach(m => {
    if (m.status === "Played" && m.scores[player.id]) {
      const entry = m.scores[player.id];
      const strokeVal = parseInt(entry.stroke);
      
      if (!isNaN(strokeVal)) {
        const factor = m.holesCount === 18 ? 2 : 1;
        const normStroke = strokeVal / factor;
        playerScores.push(normStroke); // Keep 9-hole normalized in playerScores for consistency stdDev and trend charts
        
        totalStrokes += strokeVal;
        total9HoleBlocks += factor;
        
        // Dynamic aggregation if hole-by-hole scores were logged
        if (entry.holes && Array.isArray(entry.holes) && (entry.holes.length === 9 || entry.holes.length === 18)) {
          let totalFW = 0, possibleFW = 0;
          let totalGIR = 0;
          let totalPutts = 0;
          let totalPen = 0;
          let totalUD = 0;

          const pars = m.coursePars || DEFAULT_COURSE_PARS;

          entry.holes.forEach((h, idx) => {
            const par = pars[idx] || 4;
            const score = parseInt(h.score) || par;

            // FW Track: Lock Par 3s automatically (N/A)
            if (par > 3) {
              possibleFW++;
              if (h.fw === "Yes") totalFW++;
            }

            if (h.gir === "Yes") totalGIR++;
            
            const putts = parseInt(h.putts) || 2;
            totalPutts += putts;
            
            totalPen += parseInt(h.pen) || 0;

            // Up & Down manual check with Auto-Flag fallback
            if (h.ud !== undefined) {
              if (h.ud === "Yes") totalUD++;
            } else {
              if (h.gir === "No" && score <= par && putts <= 1) {
                totalUD++;
              }
            }
          });

          detailedRounds.push({
            date: m.date,
            stroke: strokeVal,
            fw: totalFW,
            possibleFW: possibleFW,
            gir: totalGIR,
            possibleGIR: entry.holes.length,
            ud: totalUD,
            putts: totalPutts,
            pen: totalPen,
            factor: factor
          });
        } else {
          // Fallback to round-level properties
          detailedRounds.push({
            date: m.date,
            stroke: strokeVal,
            fw: entry.fw,
            possibleFW: factor === 2 ? 14 : 7, // Fallback par 4s/5s count
            gir: entry.gir,
            possibleGIR: factor === 2 ? 18 : 9,
            ud: entry.ud,
            putts: entry.putts,
            pen: entry.pen,
            factor: factor
          });
        }
      }
    }
  });

  const roundsCount = playerScores.length;
  if (roundsCount === 0) {
    return {
      rounds: 0,
      avgScore: "-",
      lastScore: "-",
      lowestScore: "-",
      highScore: "-",
      improvementRate: "-",
      stdDev: 0,
      consistencyLabel: "No Rounds",
      history: [],
      detailedStats: null
    };
  }

  const avgScore = total9HoleBlocks > 0 ? Math.round(totalStrokes / total9HoleBlocks) : "-";
  
  // Raw last score
  let lastScore = "-";
  const playedByPlayer = matches.filter(m => m.status === "Played" && m.scores[player.id] && !isNaN(parseInt(m.scores[player.id].stroke)));
  if (playedByPlayer.length > 0) {
    const lastMatch = playedByPlayer[playedByPlayer.length - 1];
    lastScore = parseInt(lastMatch.scores[player.id].stroke);
  }

  const lowestScore = Math.min(...playerScores);
  const highScore = Math.max(...playerScores);
  const improvementRate = lastScore !== "-" && avgScore !== "-" ? lastScore - avgScore : "-";
  const stdDev = calculateStandardDeviation(playerScores);
  const consistencyLabel = getConsistencyLabel(stdDev, roundsCount);

  // Advanced Stats summaries
  let totalFW = 0, totalPossibleFW = 0, fwBlocks = 0;
  let totalGIR = 0, totalPossibleGIR = 0, girBlocks = 0;
  let totalUD = 0, udBlocks = 0;
  let totalPutts = 0, puttsBlocks = 0;
  let totalPen = 0, penBlocks = 0;

  detailedRounds.forEach(r => {
    const f = r.factor || 1;
    const fwVal = parseFloat(r.fw);
    if (!isNaN(fwVal) && fwVal > 0) {
      totalFW += fwVal;
      totalPossibleFW += r.possibleFW || (f === 2 ? 14 : 7);
      fwBlocks += f;
    }
    const girVal = parseFloat(r.gir);
    if (!isNaN(girVal) && girVal > 0) {
      totalGIR += girVal;
      totalPossibleGIR += r.possibleGIR || (f === 2 ? 18 : 9);
      girBlocks += f;
    }
    const udVal = parseFloat(r.ud);
    if (!isNaN(udVal) && udVal > 0) {
      totalUD += udVal;
      udBlocks += f;
    }
    const puttsVal = parseFloat(r.putts);
    if (!isNaN(puttsVal) && puttsVal > 0) {
      totalPutts += puttsVal;
      puttsBlocks += f;
    }
    const penVal = parseFloat(r.pen);
    if (!isNaN(penVal) && penVal > 0) {
      totalPen += penVal;
      penBlocks += f;
    }
  });

  const detailedStats = {
    avgFW: fwBlocks > 0 ? parseFloat((totalFW / fwBlocks).toFixed(1)) : "-",
    fwPercent: totalPossibleFW > 0 ? Math.round((totalFW / totalPossibleFW) * 100) + "%" : "-",
    avgGIR: girBlocks > 0 ? parseFloat((totalGIR / girBlocks).toFixed(1)) : "-",
    girPercent: totalPossibleGIR > 0 ? Math.round((totalGIR / totalPossibleGIR) * 100) + "%" : "-",
    avgUD: udBlocks > 0 ? parseFloat((totalUD / udBlocks).toFixed(1)) : "-",
    avgPutts: puttsBlocks > 0 ? parseFloat((totalPutts / puttsBlocks).toFixed(1)) : "-",
    avgPen: penBlocks > 0 ? parseFloat((totalPen / penBlocks).toFixed(1)) : "-"
  };

  return {
    rounds: roundsCount,
    avgScore,
    lastScore,
    lowestScore,
    highScore,
    improvementRate,
    stdDev,
    consistencyLabel,
    history: playerScores,
    detailedStats
  };
}

/**
 * Auto-scores a match. Correctly selects and highlights the top N (lowest) player scores,
 * sums them to produce the team total, and calculates spreads.
 */
function analyzeMatchScoring(match, activePlayersList) {
  const scores = match.scores || {};
  const activeScores = [];

  activePlayersList.forEach(p => {
    if (scores[p.id] && scores[p.id].stroke !== undefined && scores[p.id].stroke !== null && scores[p.id].stroke !== "") {
      const strokeVal = parseInt(scores[p.id].stroke);
      if (!isNaN(strokeVal)) {
        activeScores.push({ playerId: p.id, stroke: strokeVal });
      }
    }
  });

  if (activeScores.length === 0) {
    return {
      total: (match.teamScore && match.teamScore > 0) ? match.teamScore : "-",
      scoringPlayerIds: [],
      teamDepth: "-",
      scoringDepth: "-"
    };
  }

  activeScores.sort((a, b) => a.stroke - b.stroke);

  const limit = match.countingScoresCount || 5;
  const scoringSlice = activeScores.slice(0, Math.min(limit, activeScores.length));
  const scoringPlayerIds = scoringSlice.map(item => item.playerId);
  const total = (match.teamScore && match.teamScore > 0) ? match.teamScore : scoringSlice.reduce((sum, item) => sum + item.stroke, 0);

  let teamDepth = "-";
  let scoringDepth = "-";

  if (activeScores.length >= 2) {
    const allStrokes = activeScores.map(item => item.stroke);
    teamDepth = Math.max(...allStrokes) - Math.min(...allStrokes);
  }

  if (scoringSlice.length >= 2) {
    const scoringStrokes = scoringSlice.map(item => item.stroke);
    scoringDepth = Math.max(...scoringStrokes) - Math.min(...scoringStrokes);
  }

  return {
    total,
    scoringPlayerIds,
    teamDepth,
    scoringDepth
  };
}

/**
 * Calculates current Seed Rankings based on active stroke averages.
 */
function getCalculatedSeeds(teamPlayers, playedMatches) {
  const ranked = teamPlayers.map(p => {
    const metrics = getPlayerPerformanceMetrics(p, playedMatches);
    return {
      player: p,
      avg: metrics.avgScore === "-" ? 999 : metrics.avgScore
    };
  });

  ranked.sort((a, b) => a.avg - b.avg);

  const seedMap = {};
  ranked.forEach((item, idx) => {
    seedMap[item.player.id] = item.avg === 999 ? ranked.length : idx + 1;
  });

  return seedMap;
}

// --------------------------------------------------------------------------
// UI View Renderers
// --------------------------------------------------------------------------

function switchTeam(teamName) {
  currentTeam = teamName;
  document.querySelectorAll(".team-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.team === teamName);
  });
  
  document.getElementById("team-subtitle").innerText = `${teamName} Team Roster & Matches`;
  renderActiveView();
}

function navigateTo(tabName) {
  if (tabName === "player-profile") {
    if (activeTab !== "player-profile") {
      previousTab = activeTab;
    }
  }
  activeTab = tabName;
  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.tab === tabName);
  });
  
  renderActiveView();
}

function navigateBack() {
  navigateTo(previousTab);
}

function viewMatchScoreboard(matchId) {
  currentMatchId = matchId;
  navigateTo("match-scoreboard");
}

function renderActiveView() {
  document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
  
  const activeEl = document.getElementById(`tab-${activeTab}`);
  if (activeEl) activeEl.classList.add("active");
  
  switch (activeTab) {
    case "dashboard":
      renderDashboard();
      break;
    case "schedule":
      renderScheduleList();
      break;
    case "scoreboard":
      renderScheduleGrid();
      break;
    case "roster":
      renderRosterCards();
      break;
    case "metrics":
      renderMetricsTable();
      break;
    case "match-scoreboard":
      renderMatchScoreboard(currentMatchId);
      break;
    case "player-profile":
      renderPlayerProfileView(currentPlayerId, currentProfileMatchId);
      break;
  }
}

// --------------------------------------------------------------------------
// View Renders: Season Schedule (Side-by-Side Tables)
// --------------------------------------------------------------------------
function renderScheduleList() {
  const headerTitle = document.getElementById("schedule-header-title");
  if (headerTitle) {
    headerTitle.innerText = `${currentTeam} Schedule`;
  }
  renderSingleScheduleTable(currentTeam, "schedule-table-container");
}

function initNewScheduleModal() {
  document.getElementById("record-match-form").reset();
  document.getElementById("match-entry-id").value = "";
  
  document.getElementById("match-entry-team").value = currentTeam;
  document.getElementById("match-entry-status").value = "Scheduled";
  document.getElementById("match-entry-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("match-entry-counting-count").value = currentTeam === "Varsity" ? 5 : 4;
  
  document.getElementById("match-entry-opp-players").innerHTML = "";
  
  // Hide dropdown loader row since we are creating the schedule entry itself
  const loadRow = document.getElementById("row-load-scheduled");
  if (loadRow) loadRow.style.display = "none";

  // Hide delete button
  const deleteBtn = document.getElementById("btn-delete-match");
  if (deleteBtn) deleteBtn.style.display = "none";

  loadRecordMatchPlayersList();
  toggleMatchStatusFields();
  switchRecordMatchTab("details");
  openModal("record-match-modal");
}

function populateScheduledDropdown() {
  const dropdown = document.getElementById("match-entry-load-scheduled");
  if (!dropdown) return;

  dropdown.innerHTML = `<option value="">-- Create New Match or Select Schedule --</option>`;

  const activeLevel = document.getElementById("match-entry-team").value || currentTeam;
  const scheduled = db.matches.filter(m => m.team === activeLevel && (m.status === "Scheduled" || m.status === "DNP"));

  scheduled.forEach(m => {
    const option = document.createElement("option");
    option.value = m.id;
    option.innerText = `[${formatDateShort(m.date)}] ${m.oppSchoolCode || m.oppSchoolName || "TBD"} @ ${m.course || "TBD"}`;
    dropdown.appendChild(option);
  });
}

function loadScheduledMatchData() {
  const matchId = document.getElementById("match-entry-load-scheduled").value;
  if (!matchId) {
    const team = document.getElementById("match-entry-team").value;
    document.getElementById("match-entry-id").value = "";
    document.getElementById("match-entry-date").value = new Date().toISOString().slice(0, 10);
    document.getElementById("match-entry-course").value = "";
    document.getElementById("match-entry-opp-code").value = "";
    document.getElementById("match-entry-opp-name").value = "";
    document.getElementById("match-entry-rating").value = "";
    document.getElementById("match-entry-slope").value = "";
    document.getElementById("match-entry-yardage").value = "";
    document.getElementById("match-entry-par").value = "";
    document.getElementById("match-entry-team-score").value = "";
    document.getElementById("match-entry-opp-score").value = "";
    document.getElementById("match-entry-counting-count").value = team === "Varsity" ? 5 : 4;
    document.getElementById("match-entry-override").value = "";
    return;
  }

  const match = db.matches.find(m => m.id === matchId);
  if (!match) return;

  document.getElementById("match-entry-id").value = match.id;
  document.getElementById("match-entry-date").value = match.date;
  document.getElementById("match-entry-course").value = match.course;
  document.getElementById("match-entry-opp-code").value = match.oppSchoolCode || "";
  document.getElementById("match-entry-opp-name").value = match.oppSchoolName || "";
  document.getElementById("match-entry-rating").value = match.courseRating !== undefined && match.courseRating !== null ? match.courseRating : "";
  document.getElementById("match-entry-slope").value = match.courseSlope !== undefined && match.courseSlope !== null ? match.courseSlope : "";
  document.getElementById("match-entry-yardage").value = match.courseYardage !== undefined && match.courseYardage !== null ? match.courseYardage : "";
  document.getElementById("match-entry-par").value = match.coursePar !== undefined && match.coursePar !== null ? match.coursePar : "";
  document.getElementById("match-entry-team-score").value = match.teamScore || "";
  document.getElementById("match-entry-opp-score").value = match.opponents && match.opponents[0] && match.opponents[0].score > 0 ? match.opponents[0].score : "";
  document.getElementById("match-entry-counting-count").value = match.countingScoresCount || (match.team === "Varsity" ? 5 : 4);
  document.getElementById("match-entry-override").value = match.overrideWinLose || "";
}

function handleDeleteMatch() {
  const matchId = document.getElementById("match-entry-id").value;
  if (!matchId) return;

  if (confirm("Are you sure you want to delete this match or schedule entry? This will permanently remove all scores and records associated with it.")) {
    db.matches = db.matches.filter(m => m.id !== matchId);
    saveDatabase();
    showNotification("Match entry successfully deleted.", "success");
    closeModal("record-match-modal");
    renderActiveView();
  }
}

function renderSingleScheduleTable(team, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const teamMatches = db.matches.filter(m => m.team === team).sort((a, b) => new Date(a.date) - new Date(b.date));
  const teamPlayers = db.players.filter(p => p.team === team && p.active);

  let wins = 0;
  let losses = 0;

  let tableHtml = `
    <table class="grid-sheet schedule-table">
      <thead>
        <tr>
          <th class="col-date">Date</th>
          <th style="text-align:left;">School</th>
          <th style="text-align:left;">Name</th>
          <th style="text-align:left;">Golf Course</th>
          <th>Rating</th>
          <th>Slope</th>
          <th>Yardage</th>
          <th>Par</th>
          <th>Score</th>
          <th>Opp Score</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
  `;

  if (teamMatches.length === 0) {
    tableHtml += `
      <tr>
        <td colspan="11" style="text-align:center; padding: 24px; color: var(--color-text-muted);">
          No matches found for ${team}
        </td>
      </tr>
    `;
  } else {
    teamMatches.forEach(m => {
      const isDNP = m.status === "DNP";
      const isScheduled = m.status === "Scheduled";
      const rowClass = isDNP ? "class='dnp-row'" : "";

      let rating = m.courseRating !== undefined && m.courseRating !== null ? m.courseRating : "";
      let slope = m.courseSlope !== undefined && m.courseSlope !== null ? m.courseSlope : "";
      let yardage = m.courseYardage !== undefined && m.courseYardage !== null ? m.courseYardage : "";
      let par = m.coursePar !== undefined && m.coursePar !== null ? m.coursePar : "";

      let ourScore = "-";
      let oppScore = "-";
      let outcomeHtml = "";

      if (isDNP) {
        outcomeHtml = `<span class="outcome-badge-dnp">DNP</span>`;
      } else if (isScheduled) {
        outcomeHtml = `<span class="outcome-badge-override" style="opacity: 0.7;">Sched</span>`;
      } else {
        // Played match
        const analysis = analyzeMatchScoring(m, teamPlayers);
        ourScore = analysis.total;
        oppScore = m.opponents && m.opponents[0] && m.opponents[0].score > 0 ? m.opponents[0].score : "-";

        let outcomeStr = "";
        if (m.overrideWinLose) {
          outcomeStr = m.overrideWinLose;
        } else if (ourScore !== "-" && oppScore !== "-") {
          outcomeStr = ourScore < oppScore ? "Win" : "Lose";
        }

        if (outcomeStr === "Win") {
          wins++;
          outcomeHtml = `<span class="outcome-badge-win">Win</span>`;
        } else if (outcomeStr === "Lose" || outcomeStr === "Loss") {
          losses++;
          outcomeHtml = `<span class="outcome-badge-lose">Loss</span>`;
        } else if (outcomeStr) {
          outcomeHtml = `<span class="outcome-badge-override">${outcomeStr}</span>`;
        } else {
          outcomeHtml = `-`;
        }
      }

      tableHtml += `
        <tr ${rowClass} style="cursor: pointer;" title="Double-click to edit match details" ondblclick="initEditMatchModal('${m.id}')">
          <td class="col-date" style="white-space:nowrap;">${formatDateShort(m.date)}</td>
          <td style="text-align:left; font-weight:600; color:var(--color-accent);">${m.oppSchoolCode || "-"}</td>
          <td style="text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px;">${m.oppSchoolName || "-"}</td>
          <td style="text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px;">${m.course || "-"}</td>
          <td>${rating}</td>
          <td>${slope}</td>
          <td>${yardage}</td>
          <td>${par}</td>
          <td style="font-weight:700;">${ourScore}</td>
          <td>${oppScore}</td>
          <td class="col-outcome">${outcomeHtml}</td>
        </tr>
      `;
    });
  }

  tableHtml += `
      </tbody>
      <tfoot>
        <tr class="row-total" style="border-top: 2px solid var(--border-glass);">
          <td colspan="4" style="text-align:left; font-weight:700; padding:10px 12px;">RECORD TOTALS</td>
          <td colspan="4"></td>
          <td colspan="3" style="text-align:right; font-weight:700; padding:10px 12px; color:var(--color-win);">
            <span style="color:var(--color-win);">${wins} Wins</span>
            <span style="color:var(--color-text-muted); margin: 0 8px;">-</span>
            <span style="color:var(--color-text-secondary);">${losses} Losses</span>
          </td>
        </tr>
      </tfoot>
    </table>
  `;

  container.innerHTML = tableHtml;
}

function toggleMatchStatusFields() {
  const status = document.getElementById("match-entry-status").value;
  const lineupTabBtn = document.querySelector(".modal-tab-btn[data-tab='lineup']");
  const holeEntryTabBtn = document.querySelector(".modal-tab-btn[data-tab='hole-entry']");
  const resultsRow = document.getElementById("match-results-row");

  if (status === "Scheduled" || status === "DNP") {
    // Hide Lineup and Hole entry tabs
    if (lineupTabBtn) lineupTabBtn.style.display = "none";
    if (holeEntryTabBtn) holeEntryTabBtn.style.display = "none";
    
    // Switch to details tab
    switchRecordMatchTab("details");
    
    // Hide our score / opponent score row or optional elements if needed, or keep opponent score
    if (resultsRow) {
      if (status === "DNP") {
        resultsRow.style.display = "none";
      } else {
        resultsRow.style.display = "grid";
      }
    }
  } else {
    // Show Lineup and Hole entry tabs
    if (lineupTabBtn) lineupTabBtn.style.display = "block";
    if (holeEntryTabBtn) holeEntryTabBtn.style.display = "block";
    if (resultsRow) resultsRow.style.display = "grid";
  }
}

// --------------------------------------------------------------------------
// View Renders: Dashboard
// --------------------------------------------------------------------------
function renderDashboard() {
  const teamPlayers = db.players.filter(p => p.team === currentTeam && p.active);
  const teamMatches = db.matches.filter(m => m.team === currentTeam);
  const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));
  
  let wins = 0;
  let losses = 0;
  let tournaments = 0;

  playedMatches.forEach(m => {
    if (m.overrideWinLose) {
      if (m.overrideWinLose === "Win") wins++;
      else if (m.overrideWinLose === "Lose") losses++;
      else tournaments++;
    } else {
      const analysis = analyzeMatchScoring(m, teamPlayers);
      if (analysis.total !== "-" && m.opponents && m.opponents[0] && m.opponents[0].score > 0) {
        if (analysis.total < m.opponents[0].score) wins++;
        else losses++;
      }
    }
  });

  // Top header stat cards
  if (document.getElementById("dash-wins")) document.getElementById("dash-wins").innerText = wins;
  if (document.getElementById("dash-losses")) document.getElementById("dash-losses").innerText = losses;
  if (document.getElementById("dash-tourneys")) document.getElementById("dash-tourneys").innerText = tournaments;
  
  let totalTeamScore = 0;
  let totalMatchesWithScores = 0;
  playedMatches.forEach(m => {
    const analysis = analyzeMatchScoring(m, teamPlayers);
    if (analysis.total !== "-") {
      const factor = m.holesCount === 18 ? 2 : 1;
      totalTeamScore += (analysis.total / factor);
      totalMatchesWithScores++;
    }
  });
  
  const avgTeamScore = totalMatchesWithScores > 0 ? Math.round(totalTeamScore / totalMatchesWithScores) : "-";
  if (document.getElementById("dash-avg-score")) document.getElementById("dash-avg-score").innerText = avgTeamScore;

  // Recent matches log
  const recentList = document.getElementById("dash-recent-matches");
  if (recentList) {
    recentList.innerHTML = "";
    if (playedMatches.length === 0) {
      recentList.innerHTML = `<div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="calendar"></i></div>
        <h3>No matches played yet</h3>
        <p>Schedule matches and record scores to populate your dashboard.</p>
      </div>`;
    } else {
      const recents = playedMatches.slice(-5).reverse();
      recents.forEach(m => {
        const analysis = analyzeMatchScoring(m, teamPlayers);
        const isOverride = !!m.overrideWinLose;
        
        let badgeHtml = "";
        let opponentDetails = "";
        
        if (isOverride && m.overrideWinLose !== "Win" && m.overrideWinLose !== "Lose") {
          badgeHtml = `<span class="badge badge-rank">${m.overrideWinLose}</span>`;
          opponentDetails = `${m.opponents[0]?.name || "Championships"}`;
        } else {
          const oppName = m.opponents.map(o => o.name).join(", ");
          const oppScore = m.opponents[0]?.score || 0;
          opponentDetails = `vs ${oppName}`;
          
          let outcome = "Win";
          if (isOverride) {
            outcome = m.overrideWinLose;
          } else if (analysis.total !== "-" && oppScore > 0) {
            outcome = analysis.total < oppScore ? "Win" : "Lose";
          }
          
          badgeHtml = `<span class="badge badge-${outcome.toLowerCase()}">${outcome}</span>`;
        }
        
        const oppScoreDisplay = m.opponents[0]?.score > 0 ? m.opponents[0].score : "-";

        const item = document.createElement("div");
        item.className = "recent-match-item";
        item.style.cursor = "pointer";
        item.onclick = () => viewMatchScoreboard(m.id);
        item.innerHTML = `
          <div class="match-item-info">
            <h4>${m.course}</h4>
            <p>${formatDate(m.date)} • ${opponentDetails}</p>
          </div>
          <div class="match-item-outcome">
            ${badgeHtml}
            <div class="match-item-score">
              <span>${analysis.total}</span>
              <span style="color:var(--color-text-muted);font-size:12px;font-weight:400;"> to ${oppScoreDisplay}</span>
            </div>
          </div>
        `;
        recentList.appendChild(item);
      });
    }
  }

  // ---------------------------------------------------------
  // SPREADSHEET SUMMARIES POPULATION
  // ---------------------------------------------------------
  const allVarsityPlayers = db.players.filter(p => p.team === "Varsity" && p.active);
  const allJvPlayers = db.players.filter(p => p.team === "JV" && p.active);
  const allPlayedMatches = db.matches.filter(m => m.status === "Played");

  const varsitySeeds = getCalculatedSeeds(allVarsityPlayers, allPlayedMatches);
  const jvSeeds = getCalculatedSeeds(allJvPlayers, allPlayedMatches);

  const varsityWithMetrics = allVarsityPlayers.map(p => {
    return { player: p, metrics: getPlayerPerformanceMetrics(p, allPlayedMatches) };
  }).filter(item => item.metrics.rounds > 0);

  const jvWithMetrics = allJvPlayers.map(p => {
    return { player: p, metrics: getPlayerPerformanceMetrics(p, allPlayedMatches) };
  }).filter(item => item.metrics.rounds > 0);

  // Sort ascending by Avg Score
  varsityWithMetrics.sort((a, b) => a.metrics.avgScore - b.metrics.avgScore);
  jvWithMetrics.sort((a, b) => a.metrics.avgScore - b.metrics.avgScore);

  // 1. Render Top Varsity Players
  const vTopContainer = document.getElementById("dash-varsity-top");
  if (vTopContainer) {
    vTopContainer.innerHTML = generateScorecardTableHtml(varsityWithMetrics, varsitySeeds, true);
  }

  // 2. Render Bottom Varsity Players
  const vBottomContainer = document.getElementById("dash-varsity-bottom");
  if (vBottomContainer) {
    const bottomVarsity = [...varsityWithMetrics].slice(-5).reverse();
    vBottomContainer.innerHTML = generateScorecardTableHtml(bottomVarsity, varsitySeeds, false);
  }

  // 3. Render Top JV Players
  const jvTopContainer = document.getElementById("dash-jv-top");
  if (jvTopContainer) {
    jvTopContainer.innerHTML = generateScorecardTableHtml(jvWithMetrics, jvSeeds, false);
  }

  // 4. Render Scoring Metrics Sidebar Summary (for selected team)
  const currentTeamMetricsList = currentTeam === "Varsity" ? varsityWithMetrics : jvWithMetrics;
  populateDashboardMetricsTable(currentTeamMetricsList);

  lucide.createIcons();
}

function generateScorecardTableHtml(playersWithMetrics, seedsMap, showScoringDepth = false) {
  let html = "";
  const displayList = playersWithMetrics.slice(0, 6); // show up to 6 players
  
  displayList.forEach(item => {
    const p = item.player;
    const m = item.metrics;
    const seed = seedsMap[p.id] || "-";
    const yellowClass = p.highlighted ? "class='cell-player-yellow'" : "";
    
    html += `<tr ${yellowClass}>
      <td style="font-weight:700;">${seed}</td>
      <td style="text-align:left; font-weight:600; color:var(--color-accent); cursor:pointer;" onclick="openPlayerProfileModal('${p.id}')">${p.name}</td>
      <td>${m.rounds}</td>
      <td>${m.lastScore}</td>
      <td><strong>${m.avgScore}</strong></td>
    </tr>`;
  });

  // Calculate TOTAL of the top 5 players (or all players if less than 5)
  const limit5 = displayList.slice(0, 5);
  let totalLast = 0;
  let totalAvg = 0;
  let lastScoresArray = [];
  let avgScoresArray = [];

  limit5.forEach(item => {
    const lastVal = parseInt(item.metrics.lastScore);
    const avgVal = parseInt(item.metrics.avgScore);
    if (!isNaN(lastVal)) {
      totalLast += lastVal;
      lastScoresArray.push(lastVal);
    }
    if (!isNaN(avgVal)) {
      totalAvg += avgVal;
      avgScoresArray.push(avgVal);
    }
  });

  html += `<tr class="total-summary-row">
    <td colspan="2" style="text-align:left;">TOTAL</td>
    <td></td>
    <td>${totalLast > 0 ? totalLast : "-"}</td>
    <td>${totalAvg > 0 ? totalAvg : "-"}</td>
  </tr>`;

  if (showScoringDepth && limit5.length >= 2) {
    const depthLast = lastScoresArray.length >= 2 ? (Math.max(...lastScoresArray) - Math.min(...lastScoresArray)) : "-";
    const depthAvg = avgScoresArray.length >= 2 ? (Math.max(...avgScoresArray) - Math.min(...avgScoresArray)) : "-";
    
    html += `<tr class="depth-summary-row">
      <td colspan="2" style="text-align:left; padding-left:12px;">Scoring Depth</td>
      <td></td>
      <td>${depthLast}</td>
      <td>${depthAvg}</td>
    </tr>`;
  }

  return html;
}

function populateDashboardMetricsTable(playersWithMetrics) {
  const container = document.getElementById("dash-scoring-metrics-body");
  if (!container) return;
  
  container.innerHTML = "";
  
  if (playersWithMetrics.length === 0) {
    container.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--color-text-muted);">No metrics recorded yet.</td></tr>`;
    return;
  }
  
  playersWithMetrics.forEach(item => {
    const p = item.player;
    const m = item.metrics;
    
    const detailed = m.detailedStats || {
      avgFW: "-", fwPercent: "-", avgGIR: "-", girPercent: "-", avgUD: "-", avgPutts: "-"
    };

    const tr = document.createElement("tr");
    if (p.highlighted) {
      tr.className = "cell-player-yellow";
    }
    
    tr.innerHTML = `
      <td style="text-align:left; font-weight:600; color:var(--color-accent); white-space:nowrap; cursor:pointer;" onclick="openPlayerProfileModal('${p.id}')">${p.name}</td>
      <td>${m.rounds}</td>
      <td><strong>${m.avgScore}</strong></td>
      <td>${detailed.fwPercent}</td>
      <td>${detailed.girPercent}</td>
      <td>${detailed.avgUD}</td>
      <td>${detailed.avgPutts}</td>
    `;
    container.appendChild(tr);
  });
}


// --------------------------------------------------------------------------
// View Renders: Season Scoreboard Sheet
// --------------------------------------------------------------------------
function renderScheduleGrid() {
  const teamPlayers = db.players.filter(p => p.team === currentTeam);
  const teamMatches = db.matches.filter(m => m.team === currentTeam);
  const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));
  
  const seedRankMap = getCalculatedSeeds(teamPlayers, playedMatches);
  teamPlayers.sort((a, b) => seedRankMap[a.id] - seedRankMap[b.id]);

  const container = document.getElementById("schedule-spreadsheet-wrapper");
  container.innerHTML = "";

  if (playedMatches.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon"><i data-lucide="sheet"></i></div>
      <h3>Season Scoreboard empty</h3>
      <p>No played matches recorded. Start by scheduling a match and adding scores!</p>
    </div>`;
    lucide.createIcons();
    return;
  }

  const table = document.createElement("table");
  table.className = "grid-sheet";

  // Build Header Row
  let headerHtml = `<tr>
    <th class="sticky-col-left-1" style="width: 150px;">Player</th>`;
  
  playedMatches.forEach(m => {
    const displayLabel = m.overrideWinLose && m.overrideWinLose !== "Win" && m.overrideWinLose !== "Lose" 
      ? m.overrideWinLose 
      : (m.opponents[0]?.name || "TBD");
    
    headerHtml += `<th title="Click to view full scorecard grid: ${m.course} (${formatDate(m.date)})" 
                       style="cursor:pointer; background-color: var(--bg-tertiary);"
                       onclick="viewMatchScoreboard('${m.id}')">
      <div style="text-decoration: underline; color: var(--color-accent);">${formatDateShort(m.date)}</div>
      <div style="font-size:10px;font-weight:400;margin-top:2px;">${displayLabel}</div>
    </th>`;
  });

  // Interactive spreadsheet Column Adder cell
  headerHtml += `<th title="Record scores or add a new match to the scoreboard" 
                     style="cursor:pointer; background-color: rgba(255,255,255,0.02); border: 1px dashed var(--border-glass-light); text-align:center; min-width: 60px; padding: 6px;"
                     onclick="initNewMatchModal()">
    <div style="font-size: 16px; color: var(--color-accent); font-weight: bold; margin-bottom: 2px;">+</div>
    <div style="font-size:9px;color:var(--color-text-muted);font-weight:400;text-transform:uppercase;letter-spacing:0.5px;">Add Match</div>
  </th></tr>`;

  table.innerHTML = headerHtml;

  // Build Player Rows
  teamPlayers.forEach(p => {
    const metrics = getPlayerPerformanceMetrics(p, playedMatches);
    const yellowClass = p.highlighted ? "cell-player-yellow" : "";
    
    let rowHtml = `<tr class="${yellowClass}">
      <td class="col-player sticky-col-left-1 ${yellowClass}" onclick="openPlayerProfileModal('${p.id}')" style="cursor:pointer;color:var(--color-accent);">${p.name}</td>`;

    playedMatches.forEach(m => {
      const matchAnalysis = analyzeMatchScoring(m, teamPlayers);
      const playerScoreItem = m.scores[p.id];
      const isScoring = matchAnalysis.scoringPlayerIds.includes(p.id);
      
      let scoreVal = "-";
      let cellClass = "";
      let cellDblClick = "";
      
      if (playerScoreItem && playerScoreItem.stroke !== undefined && playerScoreItem.stroke !== null) {
        scoreVal = playerScoreItem.stroke;
        if (isScoring) {
          cellClass = "class='cell-scoring-highlight'";
        }
        cellDblClick = `ondblclick="openPlayerProfileModal('${p.id}')" style="cursor:pointer;" title="Double-click to view player performance profile"`;
      }

      rowHtml += `<td ${cellClass} ${cellDblClick}>${scoreVal}</td>`;
    });

    // Blank column placeholder matching the "+ Add Match" column
    rowHtml += `<td style="border: 1px dashed rgba(255,255,255,0.03); background: rgba(255,255,255,0.005);"></td></tr>`;
    
    const rowEl = document.createElement("tr");
    rowEl.innerHTML = rowHtml;
    table.appendChild(rowEl);
  });

  // Footer Rows
  const footers = [
    { label: "TOTAL", key: "total" },
    { label: "Win/Lose", key: "winlose" },
    { label: "Opp Team", key: "oppteam" },
    { label: "Opp Score", key: "oppscore" },
    { label: "Team Depth", key: "teamdepth" },
    { label: "Scoring Depth", key: "scoringdepth" }
  ];

  footers.forEach(f => {
    let rowClass = "row-total";
    if (f.key === "winlose") rowClass = "";

    let footerHtml = `<tr class="${rowClass}">
      <td class="col-player sticky-col-left-1 ${rowClass}">${f.label}</td>`;

    playedMatches.forEach(m => {
      const analysis = analyzeMatchScoring(m, teamPlayers);
      const oppName = m.opponents.map(o => o.name).join(", ");
      const oppScore = m.opponents[0]?.score > 0 ? m.opponents[0].score : "-";
      
      let cellVal = "";
      let cellBgClass = "";

      switch (f.key) {
        case "total":
          cellVal = analysis.total;
          break;
        case "winlose":
          if (m.overrideWinLose) {
            cellVal = m.overrideWinLose;
            if (cellVal === "Win") cellBgClass = "row-status-win";
            else if (cellVal === "Lose") cellBgClass = "row-status-lose";
            else cellBgClass = "row-status-rank";
          } else if (analysis.total !== "-" && oppScore > 0) {
            cellVal = analysis.total < oppScore ? "Win" : "Lose";
            cellBgClass = cellVal === "Win" ? "row-status-win" : "row-status-lose";
          } else {
            cellVal = "-";
          }
          break;
        case "oppteam":
          cellVal = oppName || "-";
          break;
        case "oppscore":
          cellVal = oppScore;
          break;
        case "teamdepth":
          cellVal = analysis.teamDepth;
          break;
        case "scoringdepth":
          cellVal = analysis.scoringDepth;
          break;
      }

      footerHtml += `<td class="${cellBgClass}">${cellVal}</td>`;
    });

    // Blank column placeholder matching the "+ Add Match" column in footer rows
    footerHtml += `<td style="border: 1px dashed rgba(255,255,255,0.03); background: rgba(255,255,255,0.005);"></td></tr>`;
    
    const footEl = document.createElement("tr");
    footEl.className = rowClass;
    footEl.innerHTML = footerHtml;
    table.appendChild(footEl);
  });

  container.appendChild(table);
  lucide.createIcons();
}

// --------------------------------------------------------------------------
// View Renders: Roster & Cards
// --------------------------------------------------------------------------
function renderRosterCards() {
  const teamPlayers = db.players.filter(p => p.team === currentTeam);
  const teamMatches = db.matches.filter(m => m.team === currentTeam);
  const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));
  
  const seedRankMap = getCalculatedSeeds(teamPlayers, playedMatches);
  const grid = document.getElementById("roster-cards-grid");
  grid.innerHTML = "";

  if (teamPlayers.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">
      <div class="empty-state-icon"><i data-lucide="users"></i></div>
      <h3>No players registered</h3>
      <p>Add Varsity/JV players to get started.</p>
    </div>`;
    lucide.createIcons();
    return;
  }

  teamPlayers.forEach(p => {
    const metrics = getPlayerPerformanceMetrics(p, playedMatches);
    const activeSeed = seedRankMap[p.id] || "-";
    
    const card = document.createElement("div");
    card.className = "player-card";
    if (p.highlighted) {
      card.style.borderColor = "var(--color-yellow-border)";
      card.style.backgroundColor = "rgba(234, 179, 8, 0.03)";
    }
    card.onclick = () => openPlayerProfileModal(p.id);

    const sparklineId = `spark-${p.id}`;
    
    card.innerHTML = `
      <div class="player-card-header">
        <div>
          <div class="player-card-name">${p.name}</div>
          <div style="font-size:12px;color:var(--color-text-muted);margin-top:2px;">
            ${p.team} Team ${!p.active ? "• Injured" : ""}
          </div>
        </div>
        <span class="player-card-seed">Seed ${activeSeed}</span>
      </div>
      
      <div class="player-card-stats">
        <div class="player-card-stat-box">
          <div class="player-card-stat-label">Stroke Avg</div>
          <div class="player-card-stat-val">${metrics.avgScore}</div>
        </div>
        <div class="player-card-stat-box">
          <div class="player-card-stat-label">Rounds</div>
          <div class="player-card-stat-val">${metrics.rounds}</div>
        </div>
        <div class="player-card-stat-box">
          <div class="player-card-stat-label">Lowest</div>
          <div class="player-card-stat-val">${metrics.lowestScore}</div>
        </div>
        <div class="player-card-stat-box">
          <div class="player-card-stat-label">Consistency</div>
          <div class="player-card-stat-val" style="font-size:13px;margin-top:6px;">
            <span class="consistency-badge ${getConsistencyClass(metrics.consistencyLabel)}">${metrics.consistencyLabel}</span>
          </div>
        </div>
      </div>
      
      <div class="player-card-sparkline">
        <canvas id="${sparklineId}" height="40" style="width:100%;height:40px;"></canvas>
      </div>
    `;
    
    grid.appendChild(card);
    
    setTimeout(() => {
      drawPlayerSparkline(sparklineId, metrics.history);
    }, 10);
  });
  
  lucide.createIcons();
}

function drawPlayerSparkline(canvasId, scoresList) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || scoresList.length < 2) return;
  const ctx = canvas.getContext("2d");
  
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  const w = canvas.width;
  const h = canvas.height;
  const padX = 8;
  const padY = 8;

  const minVal = Math.min(...scoresList);
  const maxVal = Math.max(...scoresList);
  const range = maxVal - minVal || 1;

  ctx.clearRect(0,0,w,h);
  
  ctx.beginPath();
  scoresList.forEach((score, idx) => {
    const x = padX + (idx / (scoresList.length - 1)) * (w - 2 * padX);
    const y = padY + ((maxVal - score) / range) * (h - 2 * padY);
    
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.lineTo(padX + (w - 2 * padX), h);
  ctx.lineTo(padX, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(16, 185, 129, 0.15)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fill();
}

// --------------------------------------------------------------------------
// View Renders: Scoring Metrics Dashboard
// --------------------------------------------------------------------------
function renderMetricsTable() {
  const teamPlayers = db.players.filter(p => p.team === currentTeam && p.active);
  const teamMatches = db.matches.filter(m => m.team === currentTeam);
  const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));

  const tableBody = document.getElementById("metrics-table-body");
  tableBody.innerHTML = "";

  const playersWithMetrics = teamPlayers.map(p => {
    return {
      player: p,
      metrics: getPlayerPerformanceMetrics(p, playedMatches)
    };
  });

  playersWithMetrics.sort((a, b) => {
    const aVal = a.metrics.avgScore === "-" ? 999 : a.metrics.avgScore;
    const bVal = b.metrics.avgScore === "-" ? 999 : b.metrics.avgScore;
    return aVal - bVal;
  });

  playersWithMetrics.forEach(item => {
    const p = item.player;
    const m = item.metrics;
    
    const tr = document.createElement("tr");
    if (p.highlighted) {
      tr.className = "cell-player-yellow";
    }

    const detailed = m.detailedStats || {
      avgFW: "-", fwPercent: "-", avgGIR: "-", girPercent: "-", avgUD: "-", avgPutts: "-", avgPen: "-"
    };

    tr.innerHTML = `
      <td class="col-player" onclick="openPlayerProfileModal('${p.id}')" style="cursor:pointer;color:var(--color-accent);font-weight:600;">${p.name}</td>
      <td>${m.rounds}</td>
      <td><strong>${m.avgScore}</strong></td>
      <td>${detailed.avgFW}</td>
      <td>${detailed.fwPercent}</td>
      <td>${detailed.avgGIR}</td>
      <td>${detailed.girPercent}</td>
      <td>${detailed.avgUD}</td>
      <td>${detailed.avgPutts}</td>
      <td>${detailed.avgPen}</td>
    `;
    
    tableBody.appendChild(tr);
  });
}

// --------------------------------------------------------------------------
// View Renders: Match-Specific Roster & Scorecard Portal
// --------------------------------------------------------------------------
function renderMatchScoreboard(matchId) {
  if (!matchId) {
    navigateTo("dashboard");
    return;
  }

  const match = db.matches.find(m => m.id === matchId);
  if (!match) {
    navigateTo("dashboard");
    return;
  }

  const teamPlayers = db.players.filter(p => p.team === match.team);
  const teamMatches = db.matches.filter(m => m.team === match.team);
  const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));
  
  const seedRankMap = getCalculatedSeeds(teamPlayers, playedMatches);

  // Set match title metadata
  const opponentName = match.opponents.map(o => o.name).join(", ");
  document.getElementById("scoreboard-match-title").innerText = `${match.team === "Varsity" ? "MIHS" : "MIHS JV"} vs ${opponentName}`;
  document.getElementById("scoreboard-match-subtitle").innerText = `${formatDate(match.date)} • ${match.team} Match @ ${match.course}`;

  // Assemble players array
  const scoreboardPlayers = [];
  
  // Add Roster Players
  teamPlayers.forEach(p => {
    if (match.scores[p.id] && match.scores[p.id].stroke !== undefined) {
      scoreboardPlayers.push({
        id: p.id,
        name: p.name,
        school: match.team === "Varsity" ? "MIHS" : "MIHS JV",
        seed: seedRankMap[p.id] || "-",
        stroke: parseInt(match.scores[p.id].stroke),
        holes: match.scores[p.id].holes || null,
        isRoster: true,
        highlighted: p.highlighted
      });
    }
  });

  // Add Opponent Players
  Object.keys(match.scores).forEach(key => {
    if (key.startsWith("opp_") || !teamPlayers.find(p => p.id === key)) {
      const s = match.scores[key];
      if (s && s.stroke !== undefined) {
        scoreboardPlayers.push({
          id: key,
          name: s.name || "Opponent Player",
          school: s.school || opponentName || "OPP",
          seed: s.seed || "-",
          stroke: parseInt(s.stroke),
          holes: s.holes || null,
          isRoster: false,
          highlighted: false
        });
      }
    }
  });

  // Sort by stroke score to calculate ranks
  scoreboardPlayers.sort((a, b) => a.stroke - b.stroke);

  // Dynamic ranking calculator supporting ties
  scoreboardPlayers.forEach((item, idx) => {
    if (idx > 0 && item.stroke === scoreboardPlayers[idx - 1].stroke) {
      item.rank = scoreboardPlayers[idx - 1].rank;
    } else {
      item.rank = idx + 1;
    }
  });

  // Re-sort for display (matches playing order or seed)
  // To keep it clean, we can sort: Roster players first (by seed), then opponents (by seed)
  scoreboardPlayers.sort((a, b) => {
    if (a.isRoster && !b.isRoster) return -1;
    if (!a.isRoster && b.isRoster) return 1;
    return a.seed - b.seed;
  });

  // ---------------------------------------------------------
  // 1. Render spreadsheet grid sheet matching 1st screenshot
  // ---------------------------------------------------------
  const gridContainer = document.getElementById("scoreboard-spreadsheet-wrapper");
  gridContainer.innerHTML = "";

  const table = document.createElement("table");
  table.className = "grid-sheet";

  const pars = match.coursePars || DEFAULT_COURSE_PARS;
  const holesCount = pars.length;

  // Build spreadsheet header row
  let headerHtml = `<thead><tr>
    <th>Playing Order</th>
    <th class="col-player sticky-col-left-1" style="width: 150px;">Player</th>
    <th>School</th>
    <th>Seed Played</th>
    <th>Ranking</th>
    <th class="sticky-col-right-1" style="width: 80px;">Total Score</th>`;
  
  for (let i = 1; i <= holesCount; i++) {
    headerHtml += `<th>Hole ${i}</th>`;
  }
  headerHtml += `</tr></thead>`;
  table.innerHTML = headerHtml;

  // Identify scoring players for each school (top 5 lowest)
  const limit = match.countingScoresCount || 5;
  const mihsPlayers = scoreboardPlayers.filter(item => item.school.startsWith("MIHS")).sort((a,b) => a.stroke - b.stroke);
  const oppPlayers = scoreboardPlayers.filter(item => !item.school.startsWith("MIHS")).sort((a,b) => a.stroke - b.stroke);

  const mihsScoringIds = mihsPlayers.slice(0, Math.min(limit, mihsPlayers.length)).map(item => item.id);
  const oppScoringIds = oppPlayers.slice(0, Math.min(limit, oppPlayers.length)).map(item => item.id);

  const totalPar = pars.reduce((a,b) => a+b, 0);

  const tbody = document.createElement("tbody");

  scoreboardPlayers.forEach((item, idx) => {
    const isScoring = item.school.startsWith("MIHS") 
      ? mihsScoringIds.includes(item.id) 
      : oppScoringIds.includes(item.id);
    
    const highlightClass = isScoring ? "cell-scoring-highlight" : "";
    const yellowClass = item.highlighted ? "cell-player-yellow" : "";

    let rowHtml = `<tr class="${yellowClass}">
      <td>${idx + 1}</td>
      <td class="col-player sticky-col-left-1 ${yellowClass}" ${item.isRoster ? `style="cursor:pointer;color:var(--color-accent); font-weight:600;" onclick="openPlayerProfileModal('${item.id}', '${match.id}')"` : ""}>${item.name}</td>
      <td>${item.school}</td>
      <td>${item.seed}</td>
      <td>${formatOrdinal(item.rank)}</td>
      <td class="sticky-col-right-1 ${highlightClass}">${item.stroke}</td>`;

    // Hole score cells with par relation highlights
    for (let i = 0; i < holesCount; i++) {
      let cellVal = "-";
      let cellClass = "";
      
      if (item.holes && item.holes[i] && item.holes[i].score) {
        const score = parseInt(item.holes[i].score);
        const par = pars[i] || 4;
        cellVal = score;

        if (score < par) {
          cellClass = "class='birdie-cell'"; // Red in your sheet!
        } else if (score > par) {
          cellClass = "class='bogey-cell'";
        } else {
          cellClass = "class='par-cell'";
        }
      }
      rowHtml += `<td ${cellClass}>${cellVal}</td>`;
    }

    rowHtml += `</tr>`;
    
    const tr = document.createElement("tr");
    tr.className = yellowClass;
    tr.innerHTML = rowHtml;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  gridContainer.appendChild(table);

  // ---------------------------------------------------------
  // 2. Render standings and school cards matching 2nd screenshot
  // ---------------------------------------------------------
  
  // Calculate team scores
  const mihsTotal = mihsPlayers.slice(0, limit).reduce((sum, item) => sum + item.stroke, 0);
  const oppTotal = oppPlayers.slice(0, limit).reduce((sum, item) => sum + item.stroke, 0);
  
  const oppSchoolName = opponentName || "Opponent";
  const ourSchoolName = match.team === "Varsity" ? "Mercer Island High School" : "Mercer Island High School JV";
  const ourCodeName = match.team === "Varsity" ? "MIHS" : "MIHS JV";
  const oppCodeName = match.opponents[0]?.name || "OPP";

  const isOverride = !!match.overrideWinLose;
  let ourOutcome = "Win";
  let oppOutcome = "Loss";

  if (isOverride) {
    ourOutcome = match.overrideWinLose;
    oppOutcome = ourOutcome === "Win" ? "Loss" : (ourOutcome === "Loss" ? "Win" : "Ranked");
  } else if (mihsTotal > 0 && oppTotal > 0) {
    ourOutcome = mihsTotal < oppTotal ? "Win" : "Loss";
    oppOutcome = ourOutcome === "Win" ? "Loss" : "Win";
  }

  // Draw Match standing block
  const standingContainer = document.getElementById("scoreboard-standing-block");
  standingContainer.innerHTML = `
    <div class="school-summary-block">
      <h3>${ourSchoolName}</h3>
      <div class="school-score">${mihsTotal > 0 ? mihsTotal : "-"}</div>
      <div class="school-result result-${ourOutcome.toLowerCase().includes("win") ? "win" : "loss"}">${ourOutcome}</div>
    </div>
    <div style="font-family:var(--font-header); font-size:24px; font-weight:800; color:var(--color-text-muted);">VS</div>
    <div class="school-summary-block">
      <h3>${oppSchoolName}</h3>
      <div class="school-score">${oppTotal > 0 ? oppTotal : "-"}</div>
      <div class="school-result result-${oppOutcome.toLowerCase().includes("win") ? "win" : "loss"}">${oppOutcome}</div>
    </div>
  `;

  // Draw leaderboard (overall ranks)
  const leaderContainer = document.getElementById("scoreboard-leaderboard-list");
  leaderContainer.innerHTML = "";
  
  // Re-sort array by rank for overall top list
  const rankedPlayers = [...scoreboardPlayers].sort((a,b) => a.stroke - b.stroke);
  
  rankedPlayers.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${idx + 1}</strong></td>
      <td style="text-align:left; font-weight:600; ${item.isRoster ? 'cursor:pointer;color:var(--color-accent);' : ''}" ${item.isRoster ? `onclick="openPlayerProfileModal('${item.id}', '${match.id}')"` : ''}>${item.name}</td>
      <td>${item.school}</td>
      <td><strong>${item.stroke}</strong></td>
    `;
    leaderContainer.appendChild(tr);
  });

  // Draw school top 5 scorecards
  const top5Container = document.getElementById("scoreboard-top5-grids");
  top5Container.innerHTML = `
    <!-- Our School Card -->
    <div class="top5-school-card">
      <h3>${ourCodeName} Top ${limit}</h3>
      <div class="top5-list">
        ${mihsPlayers.slice(0, limit).map((item, idx) => `
          <div class="top5-item">
            <span ${item.isRoster ? `style="cursor:pointer;color:var(--color-accent);font-weight:600;" onclick="openPlayerProfileModal('${item.id}', '${match.id}')"` : ""}>${idx + 1}. ${item.name}</span>
            <span><strong>${item.stroke}</strong> <span style="font-size:10px;color:var(--color-text-muted);">(${formatOrdinal(item.rank)})</span></span>
          </div>
        `).join("")}
        <div class="top5-item total-row">
          <span>TOTAL</span>
          <span>${mihsTotal}</span>
        </div>
      </div>
    </div>
    
    <!-- Opponent School Card -->
    <div class="top5-school-card">
      <h3>${oppCodeName} Top ${limit}</h3>
      <div class="top5-list">
        ${oppPlayers.slice(0, limit).map((item, idx) => `
          <div class="top5-item">
            <span>${idx + 1}. ${item.name}</span>
            <span><strong>${item.stroke}</strong> <span style="font-size:10px;color:var(--color-text-muted);">(${formatOrdinal(item.rank)})</span></span>
          </div>
        `).join("")}
        <div class="top5-item total-row">
          <span>TOTAL</span>
          <span>${oppTotal}</span>
        </div>
      </div>
    </div>
  `;

  lucide.createIcons();
}

// --------------------------------------------------------------------------
// Player Performance Profile Modals
// --------------------------------------------------------------------------
let playerProfileChartInstance = null;
let profileGroupedChartInstance = null;
let profileScoreChartInstance = null;
let profilePuttingChartInstance = null;

const chartDatalabelsPlugin = {
  id: 'chartDatalabels',
  afterDatasetsDraw(chart, args, plugins) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = 'bold 11px Outfit, sans-serif';
    ctx.fillStyle = '#475569'; // Slate-600
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden) return;

      meta.data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (value !== undefined && value !== null) {
          ctx.fillText(value, bar.x, bar.y - 4);
        }
      });
    });
    ctx.restore();
  }
};

function openPlayerProfileModal(playerId, matchId = null) {
  const player = db.players.find(p => p.id === playerId);
  if (!player) return;

  currentPlayerId = playerId;
  currentProfileMatchId = matchId;
  navigateTo("player-profile");
}

function renderPlayerProfileView(playerId, matchId = null) {
  const player = db.players.find(p => p.id === playerId);
  if (!player) return;

  const isSingleMatchMode = !!matchId;
  const match = isSingleMatchMode ? db.matches.find(m => m.id === matchId) : null;
  const s = (isSingleMatchMode && match) ? match.scores[player.id] : null;
  const hasHoleByHole = !!(s && s.holes && s.holes.length > 0);

  // 1. Header Title & Subtitle
  document.getElementById("player-profile-title").innerText = player.name;
  if (isSingleMatchMode && match) {
    const opponentName = match.opponents.map(o => o.name).join(", ");
    document.getElementById("player-profile-subtitle").innerText = `${match.team} Team • ${player.year || "Sophomore"} • vs ${opponentName} on ${formatDateShort(match.date)}`;
  } else {
    document.getElementById("player-profile-subtitle").innerText = `${player.team} Team • ${player.year || "Sophomore"}`;
  }

  // 2. Dynamic Table Headers Swap
  const tableHeader = document.querySelector("#tab-player-profile thead");
  if (tableHeader) {
    if (isSingleMatchMode && hasHoleByHole) {
      tableHeader.innerHTML = `
        <tr style="background-color: #cbd5e1; color: #1e293b; font-weight: 700;">
          <th style="text-align: left; padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Hole</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Par</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">FW</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">GIR</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Putts</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">UD</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Pen</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Score</th>
        </tr>
      `;
    } else {
      tableHeader.innerHTML = `
        <tr style="background-color: #cbd5e1; color: #1e293b; font-weight: 700;">
          <th style="text-align: left; padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Name</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Date</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">FW</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">GIR</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Putts</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">UD</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Pen</th>
          <th style="padding: 8px; border: 1px solid #94a3b8; font-family:var(--font-header); font-size:12px;">Score</th>
        </tr>
      `;
    }
  }

  // 3. Dynamic Table Body Generation
  const tableBody = document.getElementById("player-profile-table-body");
  if (tableBody) {
    tableBody.innerHTML = "";

    if (isSingleMatchMode) {
      if (!s || s.stroke === undefined) {
        tableBody.innerHTML = `<tr><td colspan="8" style="padding: 20px; text-align: center; color: #64748b; font-weight: 500;">No score recorded for this player in this match.</td></tr>`;
      } else if (hasHoleByHole) {
        // --- Single Match Mode (Hole-by-Hole stats) ---
        // Parent row
        let parentRowHtml = `
          <tr style="background: #f1f5f9; color: #1e293b; font-weight: 700; font-size: 13px;">
            <td style="border: 1px solid #cbd5e1; text-align: left; padding: 8px;">
              <span style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; background: #64748b; color: white; border-radius: 3px; font-size: 10px; font-weight: bold; margin-right: 8px; cursor: pointer;">-</span>
              Hole-by-Hole Scores
            </td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
          </tr>
        `;
        tableBody.innerHTML += parentRowHtml;

        // Dynamic Hole Rows
        let totalFW = 0;
        let totalGIR = 0;
        let totalUD = 0;
        let totalPen = 0;
        let totalPutts = 0;
        let totalScore = 0;
        let totalPar = 0;

        const pars = match.coursePars || DEFAULT_COURSE_PARS;

        s.holes.forEach((h, i) => {
          const par = pars[i] || DEFAULT_COURSE_PARS[i % DEFAULT_COURSE_PARS.length] || 4;
          totalPar += par;
          totalScore += parseInt(h.score) || 0;
          totalPutts += parseInt(h.putts) || 0;
          totalPen += parseInt(h.pen) || 0;

          if (h.fw === "Yes") totalFW++;
          if (h.gir === "Yes") totalGIR++;
          if (h.ud === "Yes") totalUD++;

          let rowHtml = `
            <tr style="background: white; color: #334155; font-size: 13px;">
              <td style="border: 1px solid #cbd5e1; text-align: left; padding: 6px; font-weight: 500;">Hole ${i + 1}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 600;">${par}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${h.fw || "N/A"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${h.gir || "No"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${h.putts !== undefined ? h.putts : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${h.ud || "No"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${h.pen !== undefined ? h.pen : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 600; color: #0f172a;">${h.score}</td>
            </tr>
          `;
          tableBody.innerHTML += rowHtml;
        });

        // Bottom Row: Grand Total
        let totalRowHtml = `
          <tr style="background: #e2e8f0; color: #0f172a; font-weight: 700; font-size: 13px; border-top: 2px solid #94a3b8;">
            <td style="border: 1px solid #cbd5e1; text-align: left; padding: 8px;">Grand Total</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${totalPar}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${totalFW}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${totalGIR}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${totalPutts}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${totalUD}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${totalPen}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700; color: #0f172a;">${totalScore}</td>
          </tr>
        `;
        tableBody.innerHTML += totalRowHtml;

      } else {
        // --- Single Match Mode Fallback (Graceful summary display) ---
        // Parent row
        let parentRowHtml = `
          <tr style="background: #f1f5f9; color: #1e293b; font-weight: 700; font-size: 13px;">
            <td style="border: 1px solid #cbd5e1; text-align: left; padding: 8px;">
              <span style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; background: #64748b; color: white; border-radius: 3px; font-size: 10px; font-weight: bold; margin-right: 8px; cursor: pointer;">-</span>
              ${player.name}
            </td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
          </tr>
        `;
        tableBody.innerHTML += parentRowHtml;

        // Summary row
        let rowHtml = `
          <tr style="background: white; color: #334155; font-size: 13px;">
            <td style="border: 1px solid #cbd5e1; text-align: left; padding: 6px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 500;">${formatDateShort(match.date)}</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.fw !== undefined ? s.fw : "-"}</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.gir !== undefined ? s.gir : "-"}</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.putts !== undefined ? s.putts : "-"}</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.ud !== undefined ? s.ud : "-"}</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.pen !== undefined ? s.pen : "-"}</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 600; color: #0f172a;">${s.stroke}</td>
          </tr>
        `;
        tableBody.innerHTML += rowHtml;

        // Informative note row
        let noteRowHtml = `
          <tr style="background: white; color: #64748b; font-size: 12px; font-style: italic;">
            <td colspan="8" style="border: 1px solid #cbd5e1; padding: 12px; text-align: left;">
              <span style="display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; background: #e0f2fe; color: #0284c7; border-radius: 50%; font-size: 10px; font-weight: bold; margin-right: 8px;">i</span>
              Hole-by-hole stats were not recorded for this round. Showing overall match totals.
            </td>
          </tr>
        `;
        tableBody.innerHTML += noteRowHtml;
      }
    } else {
      // --- Season-Wide Mode ---
      const teamMatches = db.matches.filter(m => m.team === player.team);
      const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));
      const playerMatches = playedMatches.filter(m => m.scores[player.id] && m.scores[player.id].stroke !== undefined);

      if (playerMatches.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="8" style="padding: 20px; text-align: center; color: #64748b; font-weight: 500;">No rounds played by this player yet.</td></tr>`;
      } else {
        let totalFW = 0;
        let totalGIR = 0;
        let totalPutts = 0;
        let totalUD = 0;
        let totalPen = 0;
        let totalScore = 0;

        let parentRowHtml = `
          <tr style="background: #f1f5f9; color: #1e293b; font-weight: 700; font-size: 13px;">
            <td style="border: 1px solid #cbd5e1; text-align: left; padding: 8px;">
              <span style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; background: #64748b; color: white; border-radius: 3px; font-size: 10px; font-weight: bold; margin-right: 8px; cursor: pointer;">-</span>
              ${player.name}
            </td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
          </tr>
        `;
        tableBody.innerHTML += parentRowHtml;

        playerMatches.forEach(m => {
          const s = m.scores[player.id];
          totalFW += parseInt(s.fw) || 0;
          totalGIR += parseInt(s.gir) || 0;
          totalPutts += parseInt(s.putts) || 0;
          totalUD += parseInt(s.ud) || 0;
          totalPen += parseInt(s.pen) || 0;
          totalScore += parseInt(s.stroke) || 0;

          let rowHtml = `
            <tr style="background: white; color: #334155; font-size: 13px;">
              <td style="border: 1px solid #cbd5e1; text-align: left; padding: 6px;"></td>
              <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 500;">${formatDateShort(m.date)}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.fw !== undefined ? s.fw : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.gir !== undefined ? s.gir : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.putts !== undefined ? s.putts : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.ud !== undefined ? s.ud : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px;">${s.pen !== undefined ? s.pen : "0"}</td>
              <td style="border: 1px solid #cbd5e1; padding: 6px; font-weight: 600; color: #0f172a;">${s.stroke}</td>
            </tr>
          `;
          tableBody.innerHTML += rowHtml;
        });

        // Calculate dynamic divisors for non-zero entries only
        let fwDivisor = 0;
        let girDivisor = 0;
        let puttsDivisor = 0;
        let udDivisor = 0;
        let penDivisor = 0;
        const scoreDivisor = playerMatches.reduce((sum, m) => sum + (m.holesCount === 18 ? 2 : 1), 0) || 1;

        playerMatches.forEach(m => {
          const s = m.scores[player.id];
          const f = m.holesCount === 18 ? 2 : 1;

          if (s.fw !== undefined && parseInt(s.fw) > 0) fwDivisor += f;
          if (s.gir !== undefined && parseInt(s.gir) > 0) girDivisor += f;
          if (s.putts !== undefined && parseInt(s.putts) > 0) puttsDivisor += f;
          if (s.ud !== undefined && parseInt(s.ud) > 0) udDivisor += f;
          if (s.pen !== undefined && parseInt(s.pen) > 0) penDivisor += f;
        });

        const avgFW = fwDivisor > 0 ? (totalFW / fwDivisor).toFixed(1) : "-";
        const avgGIR = girDivisor > 0 ? (totalGIR / girDivisor).toFixed(1) : "-";
        const avgPutts = puttsDivisor > 0 ? (totalPutts / puttsDivisor).toFixed(1) : "-";
        const avgUD = udDivisor > 0 ? (totalUD / udDivisor).toFixed(1) : "-";
        const avgPen = penDivisor > 0 ? (totalPen / penDivisor).toFixed(1) : "-";
        const avgScore = (totalScore / scoreDivisor).toFixed(1);

        let totalRowHtml = `
          <tr style="background: #e2e8f0; color: #0f172a; font-weight: 700; font-size: 13px; border-top: 2px solid #94a3b8;">
            <td style="border: 1px solid #cbd5e1; text-align: left; padding: 8px;">Average</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px;"></td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${avgFW}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${avgGIR}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${avgPutts}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${avgUD}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700;">${avgPen}</td>
            <td style="border: 1px solid #cbd5e1; padding: 8px; font-weight: 700; color: #0f172a;">${avgScore}</td>
          </tr>
        `;
        tableBody.innerHTML += totalRowHtml;
      }
    }
  }

  // --- Chart Data Preparation ---
  let chartLabels = [];
  let chartFW = [];
  let chartGIR = [];
  let chartUD = [];
  let chartPen = [];
  let chartScore = [];
  let chartPutts = [];

  if (isSingleMatchMode && match) {
    if (s && s.stroke !== undefined) {
      if (hasHoleByHole) {
        const totalHoles = s.holes.length;
        if (totalHoles === 18) {
          // 18-hole match: plot 1st Nine, 2nd Nine, and Total 18 separately
          const holes1st = s.holes.slice(0, 9);
          const score1st = holes1st.reduce((sum, h) => sum + (parseInt(h.score) || 0), 0);
          const putts1st = holes1st.reduce((sum, h) => sum + (parseInt(h.putts) || 0), 0);
          const pen1st = holes1st.reduce((sum, h) => sum + (parseInt(h.pen) || 0), 0);
          const fw1st = holes1st.filter(h => h.fw === "Yes").length;
          const gir1st = holes1st.filter(h => h.gir === "Yes").length;
          const ud1st = holes1st.filter(h => h.ud === "Yes").length;

          const holes2nd = s.holes.slice(9, 18);
          const score2nd = holes2nd.reduce((sum, h) => sum + (parseInt(h.score) || 0), 0);
          const putts2nd = holes2nd.reduce((sum, h) => sum + (parseInt(h.putts) || 0), 0);
          const pen2nd = holes2nd.reduce((sum, h) => sum + (parseInt(h.pen) || 0), 0);
          const fw2nd = holes2nd.filter(h => h.fw === "Yes").length;
          const gir2nd = holes2nd.filter(h => h.gir === "Yes").length;
          const ud2nd = holes2nd.filter(h => h.ud === "Yes").length;

          const scoreTot = score1st + score2nd;
          const puttsTot = putts1st + putts2nd;
          const penTot = pen1st + pen2nd;
          const fwTot = fw1st + fw2nd;
          const girTot = gir1st + gir2nd;
          const udTot = ud1st + ud2nd;

          chartLabels = ['1st Nine', '2nd Nine', 'Total 18'];
          chartFW = [fw1st, fw2nd, fwTot];
          chartGIR = [gir1st, gir2nd, girTot];
          chartUD = [ud1st, ud2nd, udTot];
          chartPen = [pen1st, pen2nd, penTot];
          chartScore = [score1st, score2nd, scoreTot];
          chartPutts = [putts1st, putts2nd, puttsTot];
        } else {
          // 9-hole match: plot a single Front 9 total
          const scoreTot = s.holes.reduce((sum, h) => sum + (parseInt(h.score) || 0), 0);
          const puttsTot = s.holes.reduce((sum, h) => sum + (parseInt(h.putts) || 0), 0);
          const penTot = s.holes.reduce((sum, h) => sum + (parseInt(h.pen) || 0), 0);
          const fwTot = s.holes.filter(h => h.fw === "Yes").length;
          const girTot = s.holes.filter(h => h.gir === "Yes").length;
          const udTot = s.holes.filter(h => h.ud === "Yes").length;

          chartLabels = ['Front 9'];
          chartFW = [fwTot];
          chartGIR = [girTot];
          chartUD = [udTot];
          chartPen = [penTot];
          chartScore = [scoreTot];
          chartPutts = [puttsTot];
        }
      } else {
        // Fallback for single match summary (no hole-by-hole logs)
        chartLabels.push('Total');
        chartFW.push(parseInt(s.fw) || 0);
        chartGIR.push(parseInt(s.gir) || 0);
        chartUD.push(parseInt(s.ud) || 0);
        chartPen.push(parseInt(s.pen) || 0);
        chartScore.push(parseInt(s.stroke) || 0);
        chartPutts.push(parseInt(s.putts) || 0);
      }
    }
  } else {
    // Season-Wide Mode
    const teamMatches = db.matches.filter(m => m.team === player.team);
    const playedMatches = teamMatches.filter(m => m.status === "Played").sort((a,b) => new Date(a.date) - new Date(b.date));
    const playerMatches = playedMatches.filter(m => m.scores[player.id] && m.scores[player.id].stroke !== undefined);

    chartLabels = playerMatches.map(m => formatDateShort(m.date));
    chartFW = playerMatches.map(m => parseInt(m.scores[player.id].fw) || 0);
    chartGIR = playerMatches.map(m => parseInt(m.scores[player.id].gir) || 0);
    chartUD = playerMatches.map(m => parseInt(m.scores[player.id].ud) || 0);
    chartPen = playerMatches.map(m => parseInt(m.scores[player.id].pen) || 0);
    chartScore = playerMatches.map(m => parseInt(m.scores[player.id].stroke) || 0);
    chartPutts = playerMatches.map(m => parseInt(m.scores[player.id].putts) || 0);
  }

  // 1. Grouped stats bar chart (FW, GIR, UD, Pen)
  const groupedCtx = document.getElementById("profileGroupedBarChart")?.getContext("2d");
  if (groupedCtx) {
    if (profileGroupedChartInstance) profileGroupedChartInstance.destroy();
    const maxGroupedVal = Math.max(...chartFW, ...chartGIR, ...chartUD, ...chartPen, 1);
    profileGroupedChartInstance = new Chart(groupedCtx, {
      type: 'bar',
      plugins: [chartDatalabelsPlugin],
      data: {
        labels: chartLabels,
        datasets: [
          { label: 'FW', data: chartFW, backgroundColor: '#22c55e', borderRadius: 4 },
          { label: 'GIR', data: chartGIR, backgroundColor: '#86efac', borderRadius: 4 },
          { label: 'UD', data: chartUD, backgroundColor: '#15803d', borderRadius: 4 },
          { label: 'Pen', data: chartPen, backgroundColor: '#10b981', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { color: '#475569', font: { family: 'Outfit', weight: 600 } } }
        },
        scales: {
          y: { 
            grid: { color: '#f1f5f9' }, 
            ticks: { color: '#475569', font: { family: 'Outfit' } },
            min: 0,
            max: maxGroupedVal
          },
          x: { grid: { display: false }, ticks: { color: '#475569', font: { family: 'Outfit' } } }
        }
      }
    });
  }

  // 2. Score bar chart
  const scoreCtx = document.getElementById("profileScoreBarChart")?.getContext("2d");
  if (scoreCtx) {
    if (profileScoreChartInstance) profileScoreChartInstance.destroy();
    profileScoreChartInstance = new Chart(scoreCtx, {
      type: 'bar',
      plugins: [chartDatalabelsPlugin],
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'Score',
          data: chartScore,
          backgroundColor: '#ec4899',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#f1f5f9' }, ticks: { color: '#475569', font: { family: 'Outfit' } } },
          x: { grid: { display: false }, ticks: { color: '#475569', font: { family: 'Outfit' } } }
        }
      }
    });
  }

  // 3. Putting bar chart
  const puttingCtx = document.getElementById("profilePuttingBarChart")?.getContext("2d");
  if (puttingCtx) {
    if (profilePuttingChartInstance) profilePuttingChartInstance.destroy();
    profilePuttingChartInstance = new Chart(puttingCtx, {
      type: 'bar',
      plugins: [chartDatalabelsPlugin],
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'Putting',
          data: chartPutts,
          backgroundColor: '#fbcfe8',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: '#f1f5f9' }, ticks: { color: '#475569', font: { family: 'Outfit' } } },
          x: { grid: { display: false }, ticks: { color: '#475569', font: { family: 'Outfit' } } }
        }
      }
    });
  }

  lucide.createIcons();
}

// --------------------------------------------------------------------------
// Record Match Form & Hole-by-Hole Grid Matrix Input setup
// --------------------------------------------------------------------------
let recordMatchActiveTab = "details";
let opponentRoundsCount = 0; // Incremented to support custom opponent player inputs!

function switchRecordMatchTab(tabName) {
  recordMatchActiveTab = tabName;
  document.querySelectorAll(".modal-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".modal-tab-pane").forEach(pane => {
    pane.classList.toggle("active", pane.id === `match-pane-${tabName}`);
  });
  
  if (tabName === "hole-entry") {
    buildHoleEntryGridMatrix();
  }
}

function loadRecordMatchPlayersList() {
  const teamPlayers = db.players.filter(p => p.team === currentTeam && p.active);
  const container = document.getElementById("match-entry-players-list");
  container.innerHTML = "";

  if (teamPlayers.length === 0) {
    container.innerHTML = `<div style="padding:16px;color:var(--color-text-muted);text-align:center;">No active players registered on roster.</div>`;
    return;
  }

  // Create togglable selector row headers
  container.innerHTML = `
    <div style="font-size:12px; font-weight:700; color:var(--color-text-muted); padding:8px; border-bottom:1px solid var(--border-glass-light); margin-bottom:8px;">
      Select roster players who participated in this match:
    </div>
  `;

  teamPlayers.forEach(p => {
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.padding = "8px";
    div.style.gap = "10px";
    div.style.borderBottom = "1px dashed var(--border-glass-light)";

    div.innerHTML = `
      <input type="checkbox" class="player-lineup-checkbox" id="lineup-check-${p.id}" data-player-id="${p.id}" style="width:16px;height:16px;cursor:pointer;">
      <label for="lineup-check-${p.id}" style="cursor:pointer; font-weight:500; font-size:14px; margin-bottom:0;">${p.name}</label>
    `;
    container.appendChild(div);
  });
}

function addOpponentEntryRow(name = "", school = "", seed = null, oppId = null) {
  const container = document.getElementById("match-entry-opp-players");
  if (!container) return;

  opponentRoundsCount++;
  const activeId = oppId || `opp_custom_${opponentRoundsCount}_${Date.now()}`;
  
  const div = document.createElement("div");
  div.className = "opp-entry-row";
  div.dataset.oppId = activeId;
  div.style.display = "grid";
  div.style.gridTemplateColumns = "2fr 2fr 1fr auto";
  div.style.gap = "10px";
  div.style.alignItems = "center";
  div.style.marginBottom = "8px";

  // Preloaded school name should match opponent name if empty
  const defaultSchool = school || (document.getElementById("match-entry-opp-code") ? document.getElementById("match-entry-opp-code").value : "") || "";

  div.innerHTML = `
    <input type="text" class="form-control compact-score-input opp-name-input" placeholder="Player Name" value="${name}" required style="padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid var(--border-glass-light); color: var(--color-text-primary); border-radius: 4px;">
    <input type="text" class="form-control compact-score-input opp-school-input" placeholder="School" value="${defaultSchool}" required style="padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid var(--border-glass-light); color: var(--color-text-primary); border-radius: 4px;">
    <input type="number" class="form-control compact-score-input opp-seed-input" placeholder="Seed" value="${seed !== null ? seed : ''}" min="1" max="10" required style="padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid var(--border-glass-light); color: var(--color-text-primary); border-radius: 4px;">
    <button type="button" class="btn btn-danger" style="padding:6px; min-width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%;" onclick="removeOpponentEntryRow(this)">
      <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
    </button>
  `;

  container.appendChild(div);
  lucide.createIcons();
}

function removeOpponentEntryRow(btnEl) {
  const row = btnEl.closest(".opp-entry-row");
  if (row) {
    row.remove();
  }
}

function initEditMatchModal(matchId) {
  if (!matchId) return;
  const match = db.matches.find(m => m.id === matchId);
  if (!match) return;

  // Set match entry ID and basic info
  document.getElementById("match-entry-id").value = match.id;
  document.getElementById("match-entry-status").value = match.status || "Played";
  document.getElementById("match-entry-team").value = match.team || "Varsity";
  document.getElementById("match-entry-date").value = match.date;
  document.getElementById("match-entry-course").value = match.course;
  document.getElementById("match-entry-opp-code").value = match.oppSchoolCode || "";
  document.getElementById("match-entry-opp-name").value = match.oppSchoolName || "";
  document.getElementById("match-entry-rating").value = match.courseRating !== undefined && match.courseRating !== null ? match.courseRating : "";
  document.getElementById("match-entry-slope").value = match.courseSlope !== undefined && match.courseSlope !== null ? match.courseSlope : "";
  document.getElementById("match-entry-yardage").value = match.courseYardage !== undefined && match.courseYardage !== null ? match.courseYardage : "";
  document.getElementById("match-entry-par").value = match.coursePar !== undefined && match.coursePar !== null ? match.coursePar : "";
  document.getElementById("match-entry-holes").value = match.holesCount || match.coursePars?.length || 9;
  document.getElementById("match-entry-team-score").value = match.teamScore || "";
  document.getElementById("match-entry-opp-score").value = match.opponents && match.opponents[0] ? match.opponents[0].score : "";
  document.getElementById("match-entry-counting-count").value = match.countingScoresCount || (match.team === "Varsity" ? 5 : 4);
  document.getElementById("match-entry-override").value = match.overrideWinLose || "";

  // Clear opponent list
  document.getElementById("match-entry-opp-players").innerHTML = "";

  // Show delete button
  const deleteBtn = document.getElementById("btn-delete-match");
  if (deleteBtn) deleteBtn.style.display = "inline-flex";

  // Hide load scheduled dropdown
  const loadRow = document.getElementById("row-load-scheduled");
  if (loadRow) loadRow.style.display = "none";

  // Load roster players participating
  loadRecordMatchPlayersList();
  
  // Pre-check players who have scores recorded
  const checkboxes = document.querySelectorAll(".player-lineup-checkbox");
  checkboxes.forEach(cb => {
    const pId = cb.dataset.playerId;
    if (match.scores && match.scores[pId]) {
      cb.checked = true;
    }
  });

  // Populate custom opponent players
  const teamPlayers = db.players.filter(p => p.team === match.team);
  if (match.scores) {
    Object.keys(match.scores).forEach(key => {
      if (key.startsWith("opp_") || !teamPlayers.find(p => p.id === key)) {
        const s = match.scores[key];
        if (s && s.stroke !== undefined) {
          addOpponentEntryRow(s.name || "Opponent Player", s.school || "", s.seed || null, key);
        }
      }
    });
  }

  toggleMatchStatusFields();
  switchRecordMatchTab("details");
  openModal("record-match-modal");
}
/**
 * Builds the interactive 9-hole score input grid matrix with togglable stats drawers!
 */
function buildHoleEntryGridMatrix() {
  const container = document.getElementById("match-entry-hole-grid-container");
  container.innerHTML = "";

  const selectedCheckboxes = document.querySelectorAll(".player-lineup-checkbox:checked");
  const selectedPlayers = [];

  // Compute roster seeds for correct header labeling in scorecard entry drawers
  const teamPlayers = db.players.filter(p => p.team === currentTeam);
  const playedMatches = db.matches.filter(m => m.team === currentTeam && m.status === "Played");
  const seedRankMap = getCalculatedSeeds(teamPlayers, playedMatches);

  selectedCheckboxes.forEach(cb => {
    const id = cb.dataset.playerId;
    const player = db.players.find(p => p.id === id);
    if (player) {
      selectedPlayers.push({ id: player.id, name: player.name, isRoster: true, school: "MIHS", seed: seedRankMap[player.id] || "-" });
    }
  });

  // Read added custom opponent players
  const oppRows = document.querySelectorAll(".opp-entry-row");
  oppRows.forEach(row => {
    const name = row.querySelector(".opp-name-input").value || "Opponent Player";
    const school = row.querySelector(".opp-school-input").value || "OPP";
    const seed = parseInt(row.querySelector(".opp-seed-input").value) || 1;
    const oppId = row.dataset.oppId;
    selectedPlayers.push({ id: oppId, name: name, isRoster: false, school: school, seed: seed });
  });

  if (selectedPlayers.length === 0) {
    container.innerHTML = `<div style="padding:32px; text-align:center; color:var(--color-text-muted);">
      <i data-lucide="alert-circle" style="margin-bottom:8px; display:block; margin:0 auto 12px auto; width:32px; height:32px;"></i>
      <h3 style="font-family:var(--font-header); font-size:16px;">No lineup selected</h3>
      <p style="font-size:13px; margin-top:4px;">Go to the <strong>2. Select Lineup</strong> tab to select participating players.</p>
    </div>`;
    lucide.createIcons();
    return;
  }

  // Load existing match database if we are editing
  const editMatchId = document.getElementById("match-entry-id").value;
  const editMatch = editMatchId ? db.matches.find(m => m.id === editMatchId) : null;
  const holesCount = parseInt(document.getElementById("match-entry-holes").value) || 9;
  
  let pars = editMatch?.coursePars;
  if (!pars || pars.length !== holesCount) {
    pars = Array.from({length: holesCount}, (_, i) => {
      const default9 = [4, 3, 5, 4, 4, 3, 4, 4, 5];
      return default9[i % 9];
    });
  }

  selectedPlayers.forEach((p, idx) => {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.marginBottom = "10px";

    // Load pre-existing player score details if available
    const savedScore = editMatch?.scores[p.id];
    const initialTotal = savedScore?.stroke || "-";

    let initialFWTotal = 0;
    let initialGIRTotal = 0;
    let initialUDTotal = 0;
    let initialPenTotal = 0;
    let initialPuttsTotal = 0;

    for (let i = 0; i < holesCount; i++) {
      const h = savedScore?.holes?.[i];
      const par = pars[i] || 4;
      if (h) {
        if (h.fw === "Yes") initialFWTotal++;
        if (h.gir === "Yes") initialGIRTotal++;
        if (h.ud === "Yes") initialUDTotal++;
        initialPenTotal += parseInt(h.pen) || 0;
        initialPuttsTotal += h.putts !== undefined ? parseInt(h.putts) : 2;
      } else {
        if (par > 3) initialFWTotal++;
        initialGIRTotal++;
        initialPuttsTotal += 2;
      }
    }

    wrapper.innerHTML = `
      <div class="scorecard-player-list-item">
        <div style="text-align:left;">
          <strong style="color:var(--color-text-primary); font-size:14px;">${idxPlayerLabel(p.name, p.seed)}</strong>
          <span style="font-size:11px; color:var(--color-text-muted); margin-left:6px;">(${p.school})</span>
        </div>
        <div style="display:flex; align-items:center; gap:16px;">
          <div style="font-size:12px; color:var(--color-text-muted);">Total: <strong id="list-total-badge-${p.id}" style="color:var(--color-accent); font-size:14px;">${initialTotal}</strong></div>
          <button type="button" class="btn btn-secondary" style="padding:6px 12px; font-size:12px;" onclick="togglePlayerScorecardDrawer('${p.id}')">
            <i data-lucide="edit-3" style="width:13px;height:13px;"></i>
            <span>Edit scorecard</span>
          </button>
        </div>
      </div>
      
      <!-- Collapsible Detailed scorecard Drawer -->
      <div class="player-scorecard-drawer" id="drawer-${p.id}">
        <table class="scorecard-entry-table">
          <thead>
            <tr>
              <th class="row-label">Hole</th>
              ${Array.from({length:holesCount}, (_,i) => {
                const currentPar = pars[i] || 4;
                return `<th>
                  <div style="font-size:13px; font-weight:700; color:var(--color-accent);">${i+1}</div>
                  <div style="margin-top:2px;">
                    <select class="hole-par-select" 
                            data-hole="${i+1}"
                            style="font-size:10px; padding:2px; background:rgba(0,0,0,0.35); border:1px solid var(--border-glass-light); color:white; border-radius:4px; cursor:pointer; font-weight:500; text-align:center;"
                            onchange="handleParChange(this)">
                      <option value="3" ${currentPar === 3 ? "selected" : ""}>Par 3</option>
                      <option value="4" ${currentPar === 4 ? "selected" : ""}>Par 4</option>
                      <option value="5" ${currentPar === 5 ? "selected" : ""}>Par 5</option>
                    </select>
                  </div>
                </th>`;
              }).join("")}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            <!-- Strokes Row -->
            <tr>
              <td class="row-label">Strokes</td>
              ${Array.from({length:holesCount}, (_,i) => {
                const hVal = savedScore?.holes?.[i]?.score || "";
                return `<td>
                  <input type="number" 
                         class="form-control compact-score-input hole-stroke" 
                         value="${hVal}" 
                         min="1" 
                         max="15" 
                         data-player-id="${p.id}"
                         data-hole="${i+1}"
                         oninput="recalculateScorecardTotal('${p.id}')">
                </td>`;
              }).join("")}
              <td><strong class="player-total-badge" id="scorecard-total-badge-${p.id}">${initialTotal}</strong></td>
            </tr>
            <!-- Fairways Row (FW) -->
            <tr>
              <td class="row-label">Fairway (FW)</td>
              ${Array.from({length:holesCount}, (_,i) => {
                const par = pars[i] || 4;
                let fwVal = savedScore?.holes?.[i]?.fw;
                
                // Par 3s lock to N/A
                if (par === 3 && !fwVal) fwVal = "N/A";
                if (!fwVal) fwVal = "Yes"; // Default checked

                let icon = "✓";
                let cls = "stat-active";
                if (fwVal === "No") { icon = "✗"; cls = "stat-inactive"; }
                else if (fwVal === "N/A") { icon = "N/A"; cls = "stat-na"; }

                return `<td>
                  <button type="button" 
                          class="btn-stat-toggle ${cls}" 
                          data-stat="fw" 
                          data-player-id="${p.id}"
                          data-hole="${i+1}" 
                          data-value="${fwVal}"
                          ${par === 3 ? "disabled style='opacity:0.6; cursor:not-allowed;'" : ""}
                          onclick="toggleHoleStat(this)">${icon}</button>
                </td>`;
              }).join("")}
              <td><strong class="player-total-badge" id="fw-total-badge-${p.id}">${initialFWTotal}</strong></td>
            </tr>
            <!-- Greens Row (GIR) -->
            <tr>
              <td class="row-label">Green (GIR)</td>
              ${Array.from({length:holesCount}, (_,i) => {
                let girVal = savedScore?.holes?.[i]?.gir || "Yes"; // default hit
                let icon = "✓";
                let cls = "stat-active";
                if (girVal === "No") { icon = "✗"; cls = "stat-inactive"; }

                return `<td>
                  <button type="button" 
                          class="btn-stat-toggle ${cls}" 
                          data-stat="gir" 
                          data-player-id="${p.id}"
                          data-hole="${i+1}" 
                          data-value="${girVal}"
                          onclick="toggleHoleStat(this)">${icon}</button>
                </td>`;
              }).join("")}
              <td><strong class="player-total-badge" id="gir-total-badge-${p.id}">${initialGIRTotal}</strong></td>
            </tr>
            <!-- Up & Downs Row (UD) -->
            <tr>
              <td class="row-label">Up & Down (UD)</td>
              ${Array.from({length:holesCount}, (_,i) => {
                let udVal = savedScore?.holes?.[i]?.ud || "No"; // default miss
                let icon = "✗";
                let cls = "stat-inactive";
                if (udVal === "Yes") { icon = "✓"; cls = "stat-active"; }

                return `<td>
                  <button type="button" 
                          class="btn-stat-toggle ${cls}" 
                          data-stat="ud" 
                          data-player-id="${p.id}"
                          data-hole="${i+1}" 
                          data-value="${udVal}"
                          onclick="toggleHoleStat(this)">${icon}</button>
                </td>`;
              }).join("")}
              <td><strong class="player-total-badge" id="ud-total-badge-${p.id}">${initialUDTotal}</strong></td>
            </tr>
            <!-- Putts Row -->
            <tr>
              <td class="row-label">Putts</td>
              ${Array.from({length:holesCount}, (_,i) => {
                const puttsVal = savedScore?.holes?.[i]?.putts !== undefined ? savedScore.holes[i].putts : 2;
                return `<td>
                  <input type="number" 
                         class="form-control compact-score-input hole-putts" 
                         value="${puttsVal}" 
                         min="0" 
                         max="10" 
                         data-player-id="${p.id}"
                         data-hole="${i+1}"
                         oninput="recalculateScorecardTotal('${p.id}')">
                </td>`;
              }).join("")}
              <td><strong class="player-total-badge" id="putts-total-badge-${p.id}">${initialPuttsTotal}</strong></td>
            </tr>
            <!-- Penalties Row -->
            <tr>
              <td class="row-label">Penalties</td>
              ${Array.from({length:holesCount}, (_,i) => {
                const penVal = savedScore?.holes?.[i]?.pen || 0;
                return `<td>
                  <input type="number" 
                         class="form-control compact-score-input hole-pen" 
                         value="${penVal}" 
                         min="0" 
                         max="10" 
                         data-player-id="${p.id}"
                         data-hole="${i+1}"
                         oninput="recalculateScorecardTotal('${p.id}')">
                </td>`;
              }).join("")}
              <td><strong class="player-total-badge" id="pen-total-badge-${p.id}">${initialPenTotal}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    container.appendChild(wrapper);
  });

  lucide.createIcons();
}

function idxPlayerLabel(name, seed) {
  if (seed && seed !== "-") {
    return `${name} (Seed ${seed})`;
  }
  return name;
}

function handleParChange(selectEl) {
  const holeIdx = parseInt(selectEl.dataset.hole) - 1;
  const newPar = parseInt(selectEl.value) || 4;

  // 1. Synchronize all par select dropdowns for this hole across all player scorecards
  document.querySelectorAll(`.hole-par-select[data-hole="${holeIdx + 1}"]`).forEach(sel => {
    sel.value = newPar;
  });

  // 2. Update FW button states for this hole for all players
  document.querySelectorAll(`.btn-stat-toggle[data-stat="fw"][data-hole="${holeIdx + 1}"]`).forEach(btn => {
    const playerId = btn.dataset.playerId;
    if (newPar === 3) {
      btn.dataset.value = "N/A";
      btn.innerText = "N/A";
      btn.className = "btn-stat-toggle stat-na";
      btn.disabled = true;
      btn.style.opacity = "0.6";
      btn.style.cursor = "not-allowed";
    } else {
      if (btn.dataset.value === "N/A" || btn.disabled) {
        btn.dataset.value = "Yes";
        btn.innerText = "✓";
        btn.className = "btn-stat-toggle stat-active";
      }
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
    
    // Recalculate totals for this player
    if (playerId) {
      recalculateScorecardTotal(playerId);
    }
  });
}

function togglePlayerScorecardDrawer(playerId) {
  const drawer = document.getElementById(`drawer-${playerId}`);
  if (drawer) {
    drawer.classList.toggle("active");
  }
}

function toggleHoleStat(btnEl) {
  const stat = btnEl.dataset.stat;
  let val = btnEl.dataset.value;
  const playerId = btnEl.dataset.playerId;

  if (stat === "fw") {
    // Cycle: Yes -> No -> N/A -> Yes
    if (val === "Yes") {
      val = "No";
      btnEl.innerText = "✗";
      btnEl.className = "btn-stat-toggle stat-inactive";
    } else if (val === "No") {
      val = "N/A";
      btnEl.innerText = "N/A";
      btnEl.className = "btn-stat-toggle stat-na";
    } else {
      val = "Yes";
      btnEl.innerText = "✓";
      btnEl.className = "btn-stat-toggle stat-active";
    }
  } else {
    // Cycle: Yes -> No -> Yes
    if (val === "Yes") {
      val = "No";
      btnEl.innerText = "✗";
      btnEl.className = "btn-stat-toggle stat-inactive";
    } else {
      val = "Yes";
      btnEl.innerText = "✓";
      btnEl.className = "btn-stat-toggle stat-active";
    }
  }
  
  btnEl.dataset.value = val;
  if (playerId) {
    recalculateScorecardTotal(playerId);
  }
}

function recalculateScorecardTotal(playerId) {
  const drawer = document.getElementById(`drawer-${playerId}`);
  if (!drawer) return;

  // 1. Strokes Total
  const strokeInputs = drawer.querySelectorAll(".compact-score-input.hole-stroke");
  let strokeTotal = 0;
  let strokeFilled = 0;
  strokeInputs.forEach(inp => {
    const val = parseInt(inp.value);
    if (!isNaN(val)) {
      strokeTotal += val;
      strokeFilled++;
    }
  });
  const strokeBadge = document.getElementById(`scorecard-total-badge-${playerId}`);
  if (strokeBadge) strokeBadge.innerText = strokeFilled > 0 ? strokeTotal : "-";
  const listBadge = document.getElementById(`list-total-badge-${playerId}`);
  if (listBadge) listBadge.innerText = strokeFilled > 0 ? strokeTotal : "-";

  // 2. FW Total
  const fwBtns = drawer.querySelectorAll(".btn-stat-toggle[data-stat='fw']");
  let fwTotal = 0;
  fwBtns.forEach(btn => {
    if (btn.dataset.value === "Yes") fwTotal++;
  });
  const fwBadge = document.getElementById(`fw-total-badge-${playerId}`);
  if (fwBadge) fwBadge.innerText = fwTotal;

  // 3. GIR Total
  const girBtns = drawer.querySelectorAll(".btn-stat-toggle[data-stat='gir']");
  let girTotal = 0;
  girBtns.forEach(btn => {
    if (btn.dataset.value === "Yes") girTotal++;
  });
  const girBadge = document.getElementById(`gir-total-badge-${playerId}`);
  if (girBadge) girBadge.innerText = girTotal;

  // 4. UD Total
  const udBtns = drawer.querySelectorAll(".btn-stat-toggle[data-stat='ud']");
  let udTotal = 0;
  udBtns.forEach(btn => {
    if (btn.dataset.value === "Yes") udTotal++;
  });
  const udBadge = document.getElementById(`ud-total-badge-${playerId}`);
  if (udBadge) udBadge.innerText = udTotal;

  // 5. Penalties Total
  const penInputs = drawer.querySelectorAll(".compact-score-input.hole-pen");
  let penTotal = 0;
  penInputs.forEach(inp => {
    const val = parseInt(inp.value);
    if (!isNaN(val)) penTotal += val;
  });
  const penBadge = document.getElementById(`pen-total-badge-${playerId}`);
  if (penBadge) penBadge.innerText = penTotal;

  // 6. Putts Total
  const puttsInputs = drawer.querySelectorAll(".compact-score-input.hole-putts");
  let puttsTotal = 0;
  puttsInputs.forEach(inp => {
    const val = parseInt(inp.value);
    if (!isNaN(val)) puttsTotal += val;
  });
  const puttsBadge = document.getElementById(`putts-total-badge-${playerId}`);
  if (puttsBadge) puttsBadge.innerText = puttsTotal;
}

function handleSaveMatch(event) {
  event.preventDefault();

  const matchId = document.getElementById("match-entry-id").value || `m_${Date.now()}`;
  const matchDate = document.getElementById("match-entry-date").value;
  const matchCourse = document.getElementById("match-entry-course").value;
  const matchOppCode = document.getElementById("match-entry-opp-code").value;
  const matchOppName = document.getElementById("match-entry-opp-name").value;
  const matchOppScore = parseInt(document.getElementById("match-entry-opp-score").value) || 0;
  const matchCountingCount = parseInt(document.getElementById("match-entry-counting-count").value) || 5;
  const overrideWinLose = document.getElementById("match-entry-override").value;
  const matchStatus = document.getElementById("match-entry-status").value || "Played";
  const matchTeam = document.getElementById("match-entry-team").value || currentTeam;
  
  const matchRating = document.getElementById("match-entry-rating").value ? parseFloat(document.getElementById("match-entry-rating").value) : null;
  const matchSlope = document.getElementById("match-entry-slope").value ? parseInt(document.getElementById("match-entry-slope").value) : null;
  const matchYardage = document.getElementById("match-entry-yardage").value ? parseInt(document.getElementById("match-entry-yardage").value) : null;
  const matchPar = document.getElementById("match-entry-par").value ? parseInt(document.getElementById("match-entry-par").value) : null;
  const matchTeamScore = document.getElementById("match-entry-team-score").value ? parseInt(document.getElementById("match-entry-team-score").value) : null;

  const matchScores = {};
  const holesCount = parseInt(document.getElementById("match-entry-holes").value) || 9;
  const editMatchId = document.getElementById("match-entry-id").value;
  const editMatch = editMatchId ? db.matches.find(m => m.id === editMatchId) : null;
  const coursePars = [];
  
  for (let i = 1; i <= holesCount; i++) {
    const parSelect = document.querySelector(`.hole-par-select[data-hole="${i}"]`);
    if (parSelect) {
      coursePars.push(parseInt(parSelect.value));
    } else if (editMatch && editMatch.coursePars && editMatch.coursePars[i - 1]) {
      coursePars.push(editMatch.coursePars[i - 1]);
    } else {
      const default9 = [4, 3, 5, 4, 4, 3, 4, 4, 5];
      coursePars.push(default9[(i - 1) % 9]);
    }
  }

  if (matchStatus === "Played") {
    // Gather active player lineup IDs
    const selectedCheckboxes = document.querySelectorAll(".player-lineup-checkbox:checked");
    const activePlayerIds = [];
    selectedCheckboxes.forEach(cb => activePlayerIds.push(cb.dataset.playerId));

    // Gather custom added opponent IDs
    const oppRows = document.querySelectorAll(".opp-entry-row");
    oppRows.forEach(row => activePlayerIds.push(row.dataset.oppId));

    activePlayerIds.forEach(playerId => {
      const drawer = document.getElementById(`drawer-${playerId}`);
      if (!drawer) {
        if (editMatch && editMatch.scores && editMatch.scores[playerId]) {
          matchScores[playerId] = editMatch.scores[playerId];
        }
        return;
      }

      const strokeInputs = drawer.querySelectorAll(".compact-score-input.hole-stroke");
      const fwBtns = drawer.querySelectorAll(".btn-stat-toggle[data-stat='fw']");
      const girBtns = drawer.querySelectorAll(".btn-stat-toggle[data-stat='gir']");
      const udBtns = drawer.querySelectorAll(".btn-stat-toggle[data-stat='ud']");
      const penInputs = drawer.querySelectorAll(".compact-score-input.hole-pen");
      const puttsInputs = drawer.querySelectorAll(".compact-score-input.hole-putts");

      const holesArray = [];
      let strokeTotal = 0;
      let filled = 0;

      let totalFW = 0;
      let totalGIR = 0;
      let totalUD = 0;
      let totalPen = 0;
      let totalPutts = 0;

      for (let i = 0; i < holesCount; i++) {
        const strokeInp = strokeInputs[i];
        if (!strokeInp) continue;

        const strokeVal = parseInt(strokeInp.value);
        if (!isNaN(strokeVal)) {
          strokeTotal += strokeVal;
          filled++;

          const fwVal = fwBtns[i] ? (fwBtns[i].dataset.value || "N/A") : "N/A";
          const girVal = girBtns[i] ? (girBtns[i].dataset.value || "No") : "No";
          const udVal = udBtns[i] ? (udBtns[i].dataset.value || "No") : "No";
          const penVal = penInputs[i] ? (parseInt(penInputs[i].value) || 0) : 0;
          const puttVal = puttsInputs[i] ? (parseInt(puttsInputs[i].value) || 0) : 0;

          if (fwVal === "Yes") totalFW++;
          if (girVal === "Yes") totalGIR++;
          if (udVal === "Yes") totalUD++;
          totalPen += penVal;
          totalPutts += puttVal;

          holesArray.push({
            score: strokeVal,
            fw: fwVal,
            gir: girVal,
            ud: udVal,
            pen: penVal,
            putts: puttVal
          });
        }
      }

      if (filled > 0) {
        const isRoster = !playerId.startsWith("opp_custom_");
        
        if (isRoster) {
          matchScores[playerId] = {
            stroke: strokeTotal,
            fw: totalFW,
            gir: totalGIR,
            ud: totalUD,
            pen: totalPen,
            putts: totalPutts,
            holes: holesArray
          };
        } else {
          const oppRow = document.querySelector(`.opp-entry-row[data-opp-id="${playerId}"]`);
          const name = oppRow ? oppRow.querySelector(".opp-name-input").value : "Opponent Player";
          const school = oppRow ? oppRow.querySelector(".opp-school-input").value : "OPP";
          const seed = oppRow ? parseInt(oppRow.querySelector(".opp-seed-input").value) : 1;

          matchScores[playerId] = {
            name: name,
            school: school,
            seed: seed || 1,
            stroke: strokeTotal,
            fw: totalFW,
            gir: totalGIR,
            ud: totalUD,
            pen: totalPen,
            putts: totalPutts,
            holes: holesArray
          };
        }
      }
    });
  }

  const matchObj = {
    id: matchId,
    date: matchDate,
    team: matchTeam,
    course: matchCourse,
    oppSchoolCode: matchOppCode,
    oppSchoolName: matchOppName,
    courseRating: matchRating,
    courseSlope: matchSlope,
    courseYardage: matchYardage,
    coursePar: matchPar,
    teamScore: matchTeamScore,
    opponents: [{ name: matchOppCode, score: matchOppScore }],
    scores: matchScores,
    countingScoresCount: matchCountingCount,
    coursePars: coursePars,
    status: matchStatus,
    holesCount: holesCount
  };

  if (overrideWinLose) {
    matchObj.overrideWinLose = overrideWinLose;
  }

  db.matches = db.matches.filter(m => m.id !== matchId);
  db.matches.push(matchObj);
  saveDatabase();

  showNotification("Match scoreboard recorded successfully!", "success");
  closeModal("record-match-modal");
  renderActiveView();
}

function handleAddQuickPlayer(event) {
  event.preventDefault();
  const name = document.getElementById("quick-player-name").value;
  const isJv = document.getElementById("quick-player-jv").checked;
  
  if (!name) return;

  const newPlayer = {
    id: `p_${Date.now()}`,
    name: name,
    team: isJv ? "JV" : "Varsity",
    active: true,
    highlighted: false
  };

  db.players.push(newPlayer);
  saveDatabase();

  showNotification(`Added ${name} to ${newPlayer.team} roster.`, "success");
  closeModal("quick-player-modal");
  
  renderActiveView();
}

// --------------------------------------------------------------------------
// Modal Helpers
// --------------------------------------------------------------------------
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add("active");
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove("active");
}

function initNewMatchModal(teamLevel) {
  document.getElementById("record-match-form").reset();
  document.getElementById("match-entry-id").value = "";
  
  const activeLevel = teamLevel || currentTeam;
  document.getElementById("match-entry-team").value = activeLevel;
  document.getElementById("match-entry-status").value = "Played";
  document.getElementById("match-entry-holes").value = "9";
  document.getElementById("match-entry-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("match-entry-counting-count").value = activeLevel === "Varsity" ? 5 : 4;
  
  document.getElementById("match-entry-opp-players").innerHTML = "";
  
  // Show load scheduled dropdown and populate it
  const loadRow = document.getElementById("row-load-scheduled");
  if (loadRow) loadRow.style.display = "block";
  populateScheduledDropdown();

  // Hide delete button
  const deleteBtn = document.getElementById("btn-delete-match");
  if (deleteBtn) deleteBtn.style.display = "none";

  loadRecordMatchPlayersList();
  toggleMatchStatusFields();
  switchRecordMatchTab("details");
  openModal("record-match-modal");
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------
function formatDate(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function formatDateShort(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatOrdinal(rankNum) {
  if (isNaN(rankNum)) return "-";
  const j = rankNum % 10, k = rankNum % 100;
  if (j === 1 && k !== 11) return rankNum + "st";
  if (j === 2 && k !== 12) return rankNum + "nd";
  if (j === 3 && k !== 13) return rankNum + "rd";
  return rankNum + "th";
}

function showNotification(message, type = "success") {
  const notif = document.createElement("div");
  notif.style.position = "fixed";
  notif.style.bottom = "24px";
  notif.style.right = "24px";
  notif.style.padding = "14px 24px";
  notif.style.borderRadius = "8px";
  notif.style.fontFamily = "Outfit";
  notif.style.fontWeight = "600";
  notif.style.fontSize = "14px";
  notif.style.color = "white";
  notif.style.zIndex = "999";
  notif.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)";
  notif.style.opacity = "0";
  notif.style.transform = "translateY(10px)";
  notif.style.transition = "all 0.3s ease";

  if (type === "success") {
    notif.style.backgroundColor = "var(--color-win)";
    notif.style.border = "1px solid rgba(255,255,255,0.2)";
  } else {
    notif.style.backgroundColor = "var(--color-lose)";
    notif.style.border = "1px solid rgba(255,255,255,0.2)";
  }

  notif.innerText = message;
  document.body.appendChild(notif);

  setTimeout(() => {
    notif.style.opacity = "1";
    notif.style.transform = "translateY(0)";
  }, 10);

  setTimeout(() => {
    notif.style.opacity = "0";
    notif.style.transform = "translateY(10px)";
    setTimeout(() => notif.remove(), 300);
  }, 3500);
}

// Bootstrap
document.addEventListener("DOMContentLoaded", () => {
  initDatabase();
  switchTeam("Varsity");
  navigateTo("dashboard");
  
  document.getElementById("btn-export-db").addEventListener("click", exportDatabase);
  document.getElementById("input-import-db").addEventListener("change", importDatabase);
  document.getElementById("quick-player-form").addEventListener("submit", handleAddQuickPlayer);
  document.getElementById("record-match-form").addEventListener("submit", handleSaveMatch);

  const matchTeamSelect = document.getElementById("match-entry-team");
  if (matchTeamSelect) {
    matchTeamSelect.addEventListener("change", () => {
      populateScheduledDropdown();
    });
  }

  const matchHolesSelect = document.getElementById("match-entry-holes");
  if (matchHolesSelect) {
    matchHolesSelect.addEventListener("change", () => {
      const holes = parseInt(matchHolesSelect.value) || 9;
      const parInput = document.getElementById("match-entry-par");
      const yardageInput = document.getElementById("match-entry-yardage");
      
      if (parInput) {
        parInput.placeholder = holes === 18 ? "72" : "36";
        const matchId = document.getElementById("match-entry-id").value;
        if (!matchId) {
          parInput.value = holes === 18 ? "72" : "36";
        }
      }
      if (yardageInput) {
        yardageInput.placeholder = holes === 18 ? "5360" : "2680";
        const matchId = document.getElementById("match-entry-id").value;
        if (!matchId && (!yardageInput.value || yardageInput.value === "2680" || yardageInput.value === "5360")) {
          yardageInput.value = holes === 18 ? "5360" : "2680";
        }
      }
    });
  }
});

// ==========================================================================
// Mobile Responsive UI Interactivity Helpers
// ==========================================================================
function toggleMobileActionsMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("mobile-actions-dropdown");
  if (menu) {
    menu.classList.toggle("active");
  }
}

function triggerMobileBackup() {
  const btn = document.getElementById("btn-export-db");
  if (btn) {
    btn.click();
  }
  // Close menu
  const menu = document.getElementById("mobile-actions-dropdown");
  if (menu) menu.classList.remove("active");
}

function triggerMobileRestore() {
  const input = document.getElementById("input-import-db");
  if (input) {
    input.click();
  }
  // Close menu
  const menu = document.getElementById("mobile-actions-dropdown");
  if (menu) menu.classList.remove("active");
}

// Global click listener to close mobile menu when tapping outside
document.addEventListener("click", (event) => {
  const menu = document.getElementById("mobile-actions-dropdown");
  const trigger = document.getElementById("btn-mobile-actions-trigger");
  if (menu && menu.classList.contains("active")) {
    if (!menu.contains(event.target) && (!trigger || !trigger.contains(event.target))) {
      menu.classList.remove("active");
    }
  }
});

