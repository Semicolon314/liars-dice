// Helper functions for cyrpto protocol
function hash(data) {
  var sha = new jsSHA("SHA-512", "TEXT");
  sha.update(data);
  return sha.getHash("HEX");
}

function getSeed(cs) {
  return hash(cs.sort().join(""));
}

function getPublic(s, c) {
  return hash(s + c);
}

function getPrivate(s, k) {
  return hash(s + k);
}

function getDice(h) {
  var num = parseInt(h.substring(0, 8), 16)
  var dice = [];
  for (var i = 0; i < 5; i++) {
    dice.push(num % 6 + 1);
    num = (num - num % 6) / 6;
  }
  return dice;
}

// Game helper functions

// returns true if b is a valid bet after a
function betCompare(a, b) {
  return a === null || a.face > 0 && ((b.count === 0 && b.face === 0) || b.count > a.count || (b.count === a.count && b.face > a.face));
}

function byProperty(prop) {
  return function(a, b) {
    return ((a[prop] < b[prop]) ? -1 : ((a[prop] > b[prop]) ? 1 : 0));
  };
}

function shortId(token) {
  return token.split("-")[0];
}

function s4() {
  return Math.floor((1 + Math.random()) * 0x10000)
    .toString(16)
    .substring(1);
}

function genK() {
  return s4() + s4() + s4() + s4() + s4() + s4() + s4() + s4()
}

// Angular app
var app = angular.module("myApp", []);
 
app.config(["$interpolateProvider", function($interpolateProvider) {
  $interpolateProvider.startSymbol("{[");
  $interpolateProvider.endSymbol("]}");
}]);

app.controller("MainController", ["$http", "$timeout", function($http, $timeout) {
  var ctrl = this;
  ctrl.token = null;
  ctrl.shortToken = null;
  ctrl.status = null;
  ctrl.queueList = null;
  ctrl.currentQueue = null;
  ctrl.currentGame = null;
  ctrl.activeGames = 0;
  ctrl.activeUsers = 0;
  var gameStateCache = null;

  if (old_token.length > 0) {
    $http.get("/status")
      .then(function(response) {
        ctrl.token = old_token;
        ctrl.shortToken = shortId(ctrl.token);
        ctrl.username = response.data.username; // should be the same
        ctrl.status = response.data.status;
        if (ctrl.status.substring(0, 5) === "queue") {
          ctrl.currentQueue = response.data.queue;
        } else if(ctrl.status.substring(0, 4) === "game") {
          gameStateCache = null;
          ctrl.currentGame = response.data.game;
          autoGameActions();
        }
        startUpdates();
      }, function(response) {
        // TODO: handle error
      });
  }

  ctrl.getToken = function() {
    if (ctrl.username.length < 3) {
      return;
    }
    $http.get("/token?username=" + ctrl.username)
      .then(function(response) {
        ctrl.token = response.data.token;
        ctrl.shortToken = shortId(ctrl.token);
        ctrl.username = response.data.username; // should be the same
        ctrl.status = "lobby";
        startUpdates();
      }, function(response) {
        // TODO: handle error
      });
  };

  ctrl.sendChat = function() {
    var msg = ctrl.chatmsg;
    ctrl.chatmsg = "";
    $http.post("/chat", {"message": msg})
      .then(function(response) {
        // TODO
      }, function(response) {
        // TODO
      });
  };

  ctrl.joinQueue = function(queueIndex) {
    $http.post("joinqueue", {"queuetype": ctrl.queueList[queueIndex].size})
      .then(function(response) {
        getUpdates(null);
      }, function(response) {

      });
  };

  ctrl.leaveQueue = function() {
    $http.post("leavequeue", {})
      .then(function(response) {
        ctrl.currentQueue = null;
        getUpdates(null);
        ctrl.getQueues();
      }, function(response) {

      });
  };

  ctrl.leaveGame = function() {
    $http.post("leavegame", {})
      .then(function(response) {
        ctrl.currentGame = null;
        gameStateCache = null;
        getUpdates(null);
        ctrl.getQueues();
      }, function(response) {

      });
  }

  ctrl.getQueues = function() {
    $http.get("getqueues")
      .then(function(response) {
        ctrl.queueList = response.data.queues;
        ctrl.activeUsers = response.data.active_users;
        ctrl.activeGames = response.data.active_games;
      }, function(response) {

      });
  };

  // A nice representation of the game state that's easier to display
  ctrl.gameState = function() {
    var g = ctrl.currentGame;
    if (!g) {
      return "";
    }
    if (gameStateCache) {
      return gameStateCache;
    }
    var users = {};
    var bets = [];

    for (var i = 0; i < g.users.length; i++) {
      var u = g.users[i];
      users[u.id] = {id: u.id, name: u.name, ready: false, rolled: false, revealed: false, d: null, c: null, k: null, dice: null, turn_order: null, is_self: u.id === shortId(ctrl.token), last_bet: null, cheater: false, score: 0};
    }

    var ds = [];
    var cs = [];
    var ks = [];
    var state = 0; // 0 is waiting for ready, 1 is waiting for Cs (rolling), 2 is betting, 3 is waiting for reveals, 4 is waiting for ready after reveal
    var curbet = {count: 0, face: 6};
    var lastTurn = null;
    for (var i = 0; i < g.state.length; i++) {
      var act = g.state[i];
      if (act.type === "d") {
        if (state != 0 || users[act.id].d != null) {
          users[act.id].cheater = true;
        }
        users[act.id].d = act.value;
        users[act.id].ready = true;
        ds.push(act.value);
        if (ds.length === g.users.length) {
          state = 1;
        }
      } else if(act.type === "c") {
        // Verify that it matches the announed d
        if (state != 1 || hash(act.value) != users[act.id].d) {
          users[act.id].cheater = true;
        }
        users[act.id].c = act.value;
        users[act.id].rolled = true;
        cs.push(act.value);
        if (cs.length === g.users.length) {
          state = 2;
        }
      } else if(act.type === "bet") {
        if (state === 2 && betCompare(curbet, act)) {
          bets.push(act);
          users[act.id].last_bet = act;
          curbet = act;
          lastTurn = act.id;
          if (act.count === 0 && act.face === 0) {
            state = 3;
          }
        } else {
          users[act.id].cheater = true;
        }
      } else if(act.type === "k") {
        if (state != 3 || hash(act.value) != users[act.id].c) {
          users[act.id].cheater = true;
        }
        users[act.id].k = act.value;
        users[act.id].revealed = true;
        ks.push(act.value);
        if (ks.length === g.users.length) {
          state = 4;
        }
      }
    }

    var seed = state >= 2 ? getSeed(cs) : null;

    var diceCounts = [0, 0, 0, 0, 0, 0, 0];
    if (seed) {
      // Set own k even if not revealed and then calculate dice for all users possible, as well as turn_order
      var ownK = window.localStorage.k;
      users[shortId(ctrl.token)].k = ownK;
      for (var i = 0; i < g.users.length; i++) {
        var u = g.users[i];
        users[u.id].turn_order = getPublic(seed, users[u.id].c);
        if(users[u.id].k) {
          users[u.id].dice = getDice(getPrivate(seed, users[u.id].k));
          for(var j = 0; j < users[u.id].dice.length; j++) {
            diceCounts[users[u.id].dice[j]] += 1;
          }
        }
      }
    }

    var sortedUsers = [];
    var lastTurnIndex = 0;
    for (var u in users) {
      sortedUsers.push(users[u]);
    }
    if (seed) {
      sortedUsers.sort(byProperty("turn_order"));
    }
    var lastTurnIndex = -1;
    if (lastTurn) {
      for (var i = 0; i < sortedUsers.length; i++) {
        if (sortedUsers[i].id == lastTurn) {
          lastTurnIndex = i;
          break;
        }
      }
    }

    if (state == 4) {
      // Find the challenger and challengee
      var challenger = lastTurnIndex;
      var challengee = (lastTurnIndex - 1 + sortedUsers.length) % sortedUsers.length;
      var challenge = sortedUsers[challengee].last_bet;
      var realCount = diceCounts[1] + diceCounts[challenge.face];
      var delta = realCount >= challenge.count ? 1 : -1;
      sortedUsers[challengee].score += delta;
      sortedUsers[challenger].score -= delta;
    }

    ctrl.betCount = curbet.count;
    ctrl.betFace = curbet.face + 1;
    if (ctrl.betFace >= 7) {
      ctrl.betFace = 2;
      ctrl.betCount += 1;
    }
    if (ctrl.betCount > 5 * sortedUsers.length) {
      ctrl.betCount = 5 * sortedUsers.length;
      ctrl.betFace = 6;
      // someone did a max bet
    }

    var obj = {
      "users": sortedUsers,
      "state": state,
      "bets": bets,
      "self": users[shortId(ctrl.token)],
      "topBet": curbet,
      "minCount": ctrl.betCount,
      "currentTurn": sortedUsers[(lastTurnIndex + 1) % sortedUsers.length].id
    };
    gameStateCache = obj;
    return obj;
  };

  ctrl.readyDice = function() {
    // Sanity check the game state
    var g = ctrl.gameState();
    if (!(g.state === 0 || g.state === 4)) {
      // TODO: also check for already revealed d
      return;
    }
    // Generate a random value for K
    window.localStorage.k = genK();
    // Generate appropriate hashes
    window.localStorage.c = hash(window.localStorage.k);
    window.localStorage.d = hash(window.localStorage.c);
    window.localStorage.published = "d";
    // Publish d
    $http.post("/action", {"type": "d", "value": window.localStorage.d})
      .then(function(response) {
        getUpdates(null);
      }, function(response) {

      });
  }

  ctrl.enableBet = function() {
    var g = ctrl.gameState();
    return !g.topBet || parseInt(ctrl.betCount) > g.topBet.count || (parseInt(ctrl.betCount) == g.topBet.count && ctrl.betFace > ctrl.gameState().topBet.face);
  }

  ctrl.placeBet = function(challenge) {
    // Ensure that the bet is okay
    var g = ctrl.gameState();
    if (g.state !== 2 || g.currentTurn !== g.self.id) {
      return;
    }
    var bet = {"type": "bet", "count": parseInt(ctrl.betCount), "face": ctrl.betFace};
    if (challenge) {
      bet.count = 0;
      bet.face = 0;
    }
    if ((bet.count < 1 || bet.count > 5 * g.users.length || bet.face < 2 || bet.face > 6) && !(bet.count == 0 && bet.face == 0)) {
      return; // don't be dumb
    }
    if(challenge && g.bets.length == 0) {
      return;
    }
    if (!betCompare(g.topBet, bet)) {
      return; // not a higher bet
    }
    // Make the bet
    $http.post("/action", bet)
      .then(function(response) {
        getUpdates(null);
      }, function(response) {

      });
  }

  // Publish C
  function rollDice() {
    // Ensure that C has not yet been published, and that everyone has published D
    var g = ctrl.gameState();
    if (g.state !== 1 || window.localStorage.published !== "d") {
      return;
    }
    window.localStorage.published = "c";
    $http.post("/action", {"type": "c", "value": window.localStorage.c})
      .then(function(response) {
        getUpdates(null);
      }, function(response) {

      });
  }

  // Publish K
  function revealDice() {
    var g = ctrl.gameState();
    if (g.state !== 3 || window.localStorage.published !== "c") {
      return;
    }
    window.localStorage.published = "k";
    $http.post("/action", {"type": "k", "value": window.localStorage.k})
      .then(function(response) {
        getUpdates(null);
      }, function(response) {

      });
  }

  function autoGameActions() {
    // Check if we should automatically reveal something
    var g = ctrl.gameState();
    if (g.state === 1 && window.localStorage.published === "d") {
      rollDice();
    } else if(g.state === 3 && window.localStorage.published === "c") {
      revealDice();
    }
  }

  function handleUpdate(update) {
    if (update.status) {
      ctrl.status = update.status;
      if (ctrl.status === "lobby") {
        ctrl.currentQueue = null;
        gameStateCache = null;
        ctrl.currentGame = null;
        ctrl.getQueues();
      }
    }
    if (update.type === "queue") {
      ctrl.currentQueue = update.queue;
    }
    if (update.type === "game") {
      ctrl.currentQueue = null;
      if (ctrl.currentGame && update.game.state.length < ctrl.currentGame.state.length) {
        // Check whether we've readied up; if not, don't update yet
        var found = false;
        for (var i = 0; i < update.game.state.length; i++) {
          if (update.game.state[i].id === ctrl.shortToken) {
            found = true;
            break;
          }
        }
        if (!found) {
          return;
        }
      }
      gameStateCache = null;
      ctrl.currentGame = update.game;
      autoGameActions();
    }
  }

  var last_id = 0;
  function getUpdates(callback) {
    $http.get("/updates?id=" + last_id)
      .then(function(response) {
        if (response.data.error) {
          // TODO: handle error
          return;
        }
        for (var i = 0; i < response.data.updates.length; i++) {
          handleUpdate(response.data.updates[i]);
          last_id = response.data.updates[i].id;
        }
        if (callback) {
          callback();
        }
      }, function(response) {
        // TODO: handle error
      });
  }

  function startUpdates() {
    ctrl.getQueues();
    (function tick() {
      getUpdates(function() {
        $timeout(tick, 1000);
      });
    })();
  }
}]);