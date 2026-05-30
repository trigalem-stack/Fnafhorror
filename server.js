const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const lobbies = {};

const DAY_NIGHT_DURATION = 6 * 60 * 1000; // 6 минут
const MAP_SIZE = 100;

io.on('connection', (socket) => {
    let currentLobby = null;

    socket.on('setNickname', (nickname) => {
        socket.nickname = nickname; socket.emit('loginSuccess'); socket.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('createLobby', (data) => {
        const lobbyId = 'lobby_' + Date.now();
        const trees = [];
        for (let i = 0; i < 60; i++) {
            let tx = (Math.random() - 0.5) * MAP_SIZE; let tz = (Math.random() - 0.5) * MAP_SIZE;
            if (Math.sqrt(tx*tx + tz*tz) < 8) { tx += 10; tz += 10; }
            trees.push({ id: 'tree_' + i, x: Number(tx.toFixed(2)), z: Number(tz.toFixed(2)), hp: 4, isCut: false, sinkY: 0 });
        }

        lobbies[lobbyId] = {
            id: lobbyId, name: data.name, password: data.password, maxPlayers: data.maxPlayers,
            admin: socket.id, players: [], isPlaying: false,
            world: {
                day: 1, isNight: false, timeProgress: 0, uidCounter: 0, 
                campfire: { x: 0, z: 0, hp: 100, level: 1 },
                trees: trees, droppedLogs: [], saplings: [], wolves: []
            }
        };
        socket.join(lobbyId); currentLobby = lobbyId; joinLobbyAction(socket, lobbies[lobbyId]);
    });

    socket.on('joinLobby', (data) => {
        const lobby = lobbies[data.id];
        if (!lobby) return socket.emit('errorMsg', 'Лобби не найдено');
        if (lobby.isPlaying) return socket.emit('errorMsg', 'Игра уже началась');
        if (lobby.players.length >= lobby.maxPlayers) return socket.emit('errorMsg', 'Лобби заполнено');
        if (lobby.password && lobby.password !== data.password) return socket.emit('errorMsg', 'Неверный пароль');
        socket.join(lobby.id); currentLobby = lobby.id; joinLobbyAction(socket, lobby);
    });

    function joinLobbyAction(socket, lobby) {
        const colors = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff, 0xffa500, 0xffffff];
        lobby.players.push({ 
            id: socket.id, name: socket.nickname,
            x: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 + 4, ry: 0,
            color: colors[lobby.players.length % colors.length], bagCount: 0, hp: 100
        });
        io.to(lobby.id).emit('lobbyUpdated', lobby); io.emit('updateLobbyList', getLobbiesList());
    }

    socket.on('playerUpdate', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const p = lobbies[currentLobby].players.find(pl => pl.id === socket.id);
        if (p && p.hp > 0) { p.x = data.x; p.z = data.z; p.ry = data.ry; }
    });

    socket.on('hitEntity', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        
        if(data.type === 'tree') {
            const tree = lobby.world.trees.find(t => t.id === data.id && !t.isCut);
            if (tree) {
                tree.hp -= 1; io.to(lobby.id).emit('treeHit', data.id); 
                if (tree.hp <= 0) {
                    tree.isCut = true;
                    // Бревна
                    for (let k = 0; k < 3; k++) {
                        lobby.world.uidCounter++;
                        lobby.world.droppedLogs.push({ id: 'log_' + lobby.world.uidCounter, x: tree.x + (Math.random() - 0.5)*1.5, y: 0.3, z: tree.z + (Math.random() - 0.5)*1.5, collected: false });
                    }
                    // Шанс выпадения саженца 100% как просил
                    socket.emit('inventorySync', {type: 'saplingDrop'});
                }
                io.to(lobby.id).emit('treeUpdated', tree);
            }
        } else if(data.type === 'wolf') {
            const wolf = lobby.world.wolves.find(w => w.id === data.id);
            if(wolf) {
                wolf.hp -= 25;
                // Звук удара о волка можно было бы добавить, но просто покажем урон
                if(wolf.hp <= 0) lobby.world.wolves = lobby.world.wolves.filter(w => w.id !== data.id);
            }
        }
    });

    socket.on('plantSapling', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        lobby.world.uidCounter++;
        lobby.world.saplings.push({
            id: 'sapling_' + lobby.world.uidCounter, x: data.x, z: data.z, stage: 0, timer: 0
        });
    });

    socket.on('collectLog', (logId) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.bagCount >= 10 || p.hp <= 0) return;

        const logIndex = lobby.world.droppedLogs.findIndex(l => l.id === logId && !l.collected);
        if (logIndex !== -1) {
            lobby.world.droppedLogs[logIndex].collected = true; 
            p.bagCount += 1; socket.emit('inventorySync', {type: 'bag', count: p.bagCount});
        }
    });

    socket.on('dropLog', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const p = lobbies[currentLobby].players.find(pl => pl.id === socket.id);
        if (!p || p.bagCount <= 0 || p.hp <= 0) return;

        p.bagCount -= 1; socket.emit('inventorySync', {type: 'bag', count: p.bagCount});
        let dist = 1.0;
        lobbies[currentLobby].world.uidCounter++;
        lobbies[currentLobby].world.droppedLogs.push({ id: 'log_' + lobbies[currentLobby].world.uidCounter, x: p.x - Math.sin(p.ry)*dist, y: 1.5, z: p.z - Math.cos(p.ry)*dist, collected: false });
    });

    socket.on('respawn', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const p = lobbies[currentLobby].players.find(pl => pl.id === socket.id);
        if (p) {
            p.hp = 100;
            p.x = (Math.random() - 0.5) * 40; p.z = (Math.random() - 0.5) * 40;
            socket.emit('forceMove', {x: p.x, z: p.z});
        }
    });

    socket.on('kickPlayer', (id) => { if (lobbies[currentLobby] && lobbies[currentLobby].admin === socket.id) { io.to(id).emit('kicked'); handlePlayerLeave({id:id}); }});
    socket.on('disbandLobby', () => { if (lobbies[currentLobby] && lobbies[currentLobby].admin === socket.id) { io.to(currentLobby).emit('lobbyDisbanded'); delete lobbies[currentLobby]; currentLobby=null; io.emit('updateLobbyList', getLobbiesList()); }});
    socket.on('leaveLobby', () => { handlePlayerLeave(socket); });
    socket.on('startGame', () => { if (lobbies[currentLobby] && lobbies[currentLobby].admin === socket.id) { lobbies[currentLobby].isPlaying = true; io.to(currentLobby).emit('gameStarted', {trees: lobbies[currentLobby].world.trees}); io.emit('updateLobbyList', getLobbiesList()); startGameTicker(currentLobby); }});
    socket.on('disconnect', () => { handlePlayerLeave(socket); });

    function handlePlayerLeave(s) {
        if (currentLobby && lobbies[currentLobby]) {
            const lobby = lobbies[currentLobby];
            lobby.players = lobby.players.filter(p => p.id !== s.id);
            if (lobby.players.length === 0) delete lobbies[currentLobby]; 
            else { io.to(lobby.id).emit('lobbyUpdated', lobby); if (lobby.admin === s.id) lobby.admin = lobby.players[0].id; }
            currentLobby = null; io.emit('updateLobbyList', getLobbiesList());
        }
    }
});

function startGameTicker(lobbyId) {
    let lastTick = Date.now();
    const interval = setInterval(() => {
        const lobby = lobbies[lobbyId];
        if (!lobby || !lobby.isPlaying) return clearInterval(interval);

        const now = Date.now(); const dt = now - lastTick; lastTick = now;

        lobby.world.timeProgress += dt;
        const wasNight = lobby.world.isNight;
        lobby.world.isNight = lobby.world.timeProgress >= DAY_NIGHT_DURATION / 2;
        if (lobby.world.timeProgress >= DAY_NIGHT_DURATION) { lobby.world.timeProgress -= DAY_NIGHT_DURATION; lobby.world.day += 1; }

        let cf = lobby.world.campfire;
        let cfRadius = cf.hp > 0 ? 15 + cf.level * 6 : 0; // Зона света
        
        // Сгорание костра
        if (cf.hp > 0) {
            cf.hp -= (dt / 1000) * (1 / (cf.level * 0.5)); // Медленнее сгорает на хай лвл
            if (cf.hp < 0) cf.hp = 0;
        }

        // Бревна в костер
        lobby.world.droppedLogs.forEach(log => {
            if (log.y > 0.2) log.y -= 0.15; else log.y = 0.2;
            if (!log.collected) {
                let dx = log.x - cf.x; let dz = log.z - cf.z;
                if (Math.sqrt(dx*dx + dz*dz) < 1.8 && log.y < 0.8) {
                    log.collected = true; 
                    let gain = Math.max(2, 20 - (cf.level * 3)); // Чем выше лвл, тем меньше дает ХП!
                    cf.hp += gain;
                    if (cf.hp >= 100 && cf.level < 10) { cf.level++; cf.hp -= 100; if(cf.hp===0) cf.hp=1; } 
                    else if (cf.hp > 100) cf.hp = 100;
                }
            }
        });
        lobby.world.droppedLogs = lobby.world.droppedLogs.filter(l => !l.collected);

        // Саженцы (Фазы роста: 5с, 90с, 90с)
        for (let i = lobby.world.saplings.length - 1; i >= 0; i--) {
            let s = lobby.world.saplings[i];
            s.timer += dt;
            if (s.stage === 0 && s.timer > 5000) s.stage = 1;
            else if (s.stage === 1 && s.timer > 95000) s.stage = 2; // +90s
            else if (s.stage === 2 && s.timer > 185000) { // +90s
                // Превращаем в дерево
                lobby.world.uidCounter++;
                const newTree = { id: 'tree_' + lobby.world.uidCounter, x: s.x, z: s.z, hp: 4, isCut: false, sinkY: 0 };
                lobby.world.trees.push(newTree);
                io.to(lobbyId).emit('treeUpdated', newTree);
                
                // Расталкиваем игроков
                lobby.players.forEach(p => {
                    let d = Math.sqrt(Math.pow(p.x - s.x, 2) + Math.pow(p.z - s.z, 2));
                    if(d < 1.0) { p.x += 1.5; p.z += 1.5; io.to(p.id).emit('forceMove', {x: p.x, z: p.z}); }
                });
                lobby.world.saplings.splice(i, 1);
            }
        }

        // Спавн волков ночью
        if(lobby.world.isNight && !wasNight) {
            let spawnCount = 2 + cf.level;
            for(let i=0; i<spawnCount; i++) {
                lobby.world.uidCounter++;
                let angle = Math.random() * Math.PI * 2;
                lobby.world.wolves.push({
                    id: 'wolf_' + lobby.world.uidCounter,
                    x: Math.cos(angle) * 40, z: Math.sin(angle) * 40, ry: 0, hp: 100, lastAttack: 0
                });
            }
        } else if(!lobby.world.isNight && wasNight) {
            lobby.world.wolves = []; // Утром пропадают
        }

        // AI Волков
        lobby.world.wolves.forEach(w => {
            // Найти ближайшего живого игрока
            let closestP = null; let minD = 999;
            lobby.players.forEach(p => {
                if(p.hp > 0) {
                    let d = Math.sqrt(Math.pow(p.x - w.x, 2) + Math.pow(p.z - w.z, 2));
                    if(d < minD) { minD = d; closestP = p; }
                }
            });

            if(closestP) {
                // Проверка зоны костра
                let dToFireP = Math.sqrt(Math.pow(closestP.x - cf.x, 2) + Math.pow(closestP.z - cf.z, 2));
                let dToFireW = Math.sqrt(Math.pow(w.x - cf.x, 2) + Math.pow(w.z - cf.z, 2));

                if (cf.hp > 0 && dToFireW < cfRadius) {
                    // Убегает от костра
                    let dx = w.x - cf.x; let dz = w.z - cf.z;
                    let len = Math.sqrt(dx*dx + dz*dz);
                    w.x += (dx/len) * 4.0 * (dt/1000); w.z += (dz/len) * 4.0 * (dt/1000);
                    w.ry = Math.atan2(dx, dz);
                } else if(cf.hp > 0 && dToFireP < cfRadius) {
                    // Игрок в костре, волк ждет на границе (смотрит на игрока)
                    let dx = closestP.x - w.x; let dz = closestP.z - w.z;
                    w.ry = Math.atan2(dx, dz);
                } else {
                    // Бежит к игроку
                    let dx = closestP.x - w.x; let dz = closestP.z - w.z;
                    if(minD > 1.2) {
                        w.x += (dx/minD) * 3.5 * (dt/1000); w.z += (dz/minD) * 3.5 * (dt/1000);
                        w.ry = Math.atan2(dx, dz);
                    } else {
                        // Атака
                        if (now - w.lastAttack > 2000) {
                            w.lastAttack = now; closestP.hp -= 15;
                            if(closestP.hp < 0) closestP.hp = 0;
                            io.to(closestP.id).emit('playerDamaged', closestP.hp);
                        }
                    }
                }
            }
        });

        // Отправка оптимизированных пакетов
        io.to(lobbyId).emit('worldSync', {
            day: lobby.world.day, isNight: lobby.world.isNight, timeProgress: lobby.world.timeProgress,
            campfire: { hp: Number(lobby.world.campfire.hp.toFixed(1)), level: lobby.world.campfire.level, x:0, z:0 },
            droppedLogs: lobby.world.droppedLogs.map(l => ({ id: l.id, x: Number(l.x.toFixed(2)), y: Number(l.y.toFixed(2)), z: Number(l.z.toFixed(2)) })),
            saplings: lobby.world.saplings.map(s => ({ id: s.id, x: Number(s.x.toFixed(2)), z: Number(s.z.toFixed(2)), stage: s.stage })),
            wolves: lobby.world.wolves.map(w => ({ id: w.id, x: Number(w.x.toFixed(2)), z: Number(w.z.toFixed(2)), ry: Number(w.ry.toFixed(2)), hp: w.hp }))
        });
        io.to(lobbyId).emit('playersSync', lobby.players.map(p => ({ id: p.id, name: p.name, color: p.color, hp: p.hp, x: Number(p.x.toFixed(2)), z: Number(p.z.toFixed(2)), ry: Number(p.ry.toFixed(2)) })));

    }, 200); // 5 FPS сервера - идеальный баланс плавности/производительности (клиент интерполирует)
}

function getLobbiesList() { return Object.values(lobbies).filter(l => !l.isPlaying).map(l => ({ id: l.id, name: l.name, hasPassword: !!l.password, playersCount: l.players.length, maxPlayers: l.maxPlayers })); }
const PORT = process.env.PORT || 3000; server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
