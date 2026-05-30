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
const MAX_SPEED = 6.0;

io.on('connection', (socket) => {
    let currentLobby = null;

    socket.on('pingRequest', () => { socket.emit('pongResponse'); });

    socket.on('setNickname', (nickname) => {
        socket.nickname = nickname; socket.emit('loginSuccess'); socket.emit('updateLobbyList', getLobbiesList());
    });

    socket.on('createLobby', (data) => {
        if (Object.values(lobbies).some(l => l.name.toLowerCase() === data.name.toLowerCase())) {
            return socket.emit('errorMsg', 'Лобби с таким названием уже существует!');
        }

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
                day: 1, isNight: false, timeProgress: 0, uidCounter: 0, lastRegenTime: Date.now(),
                campfire: { x: 0, z: 0, hp: 100, level: 1 },
                workbench: { x: 3, z: 3, wood: 0, bedCrafted: false },
                recycler: { x: 1.8, z: 3 }, // Рядом с верстаком
                trees: trees, droppedLogs: [], saplings: [], wolves: [], droppedSaplings: [], beds: [], droppedBeds: []
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
            color: colors[lobby.players.length % colors.length], bag: [], hp: 100, 
            lastUpdate: Date.now(), ping: 50
        });
        io.to(lobby.id).emit('lobbyUpdated', lobby); io.emit('updateLobbyList', getLobbiesList());
    }

    socket.on('playerUpdate', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const p = lobbies[currentLobby].players.find(pl => pl.id === socket.id);
        if (p && p.hp > 0) {
            const now = Date.now();
            const dt = (now - p.lastUpdate) / 1000;
            if (dt > 0.05) {
                const dist = Math.sqrt(Math.pow(data.x - p.x, 2) + Math.pow(data.z - p.z, 2));
                const tolerance = (data.ping && data.ping > 150) ? 2.0 : 0.5;
                if (dist / dt > MAX_SPEED + tolerance) {
                    socket.emit('forceMove', { x: p.x, z: p.z }); p.lastUpdate = now; return; 
                }
            }
            p.lastUpdate = now; p.ping = data.ping || 50; p.x = data.x; p.z = data.z; p.ry = data.ry; 
        }
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
                    for (let k = 0; k < 3; k++) {
                        lobby.world.uidCounter++;
                        let ox = (Math.random() - 0.5) * 1.2; let oz = (Math.random() - 0.5) * 1.2;
                        lobby.world.droppedLogs.push({ id: 'log_' + lobby.world.uidCounter, x: tree.x + ox, y: 0.5 + k*0.2, z: tree.z + oz, collected: false });
                    }
                    lobby.world.uidCounter++;
                    lobby.world.droppedSaplings.push({ id: 'sap_' + lobby.world.uidCounter, x: tree.x + (Math.random() - 0.5)*1.5, y: 0.3, z: tree.z + (Math.random() - 0.5)*1.5, collected: false });
                }
                io.to(lobby.id).emit('treeUpdated', tree);
            }
        } else if(data.type === 'wolf') {
            const wolf = lobby.world.wolves.find(w => w.id === data.id);
            if(wolf) { wolf.hp -= 25; if(wolf.hp <= 0) lobby.world.wolves = lobby.world.wolves.filter(w => w.id !== data.id); }
        }
    });

    socket.on('plantSapling', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        lobby.world.uidCounter++;
        lobby.world.saplings.push({ id: 'sapling_' + lobby.world.uidCounter, x: data.x, z: data.z, stage: 0, timer: 0 });
    });

    socket.on('placeBed', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        lobby.world.uidCounter++;
        lobby.world.beds.push({ id: 'bed_' + lobby.world.uidCounter, x: data.x, z: data.z });
    });

    socket.on('craftBed', () => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        if(lobby.world.workbench.wood >= 15 && !lobby.world.workbench.bedCrafted) {
            lobby.world.workbench.wood -= 15;
            lobby.world.workbench.bedCrafted = true;
            socket.emit('itemToSlot', 'bed'); // Добавляем в инвентарь (в слот)
        }
    });

    socket.on('collectItem', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.hp <= 0) return;

        if (data.type === 'log') {
            const index = lobby.world.droppedLogs.findIndex(l => l.id === data.id && !l.collected);
            if (index !== -1 && data.toBag && p.bag.length < 10) {
                lobby.world.droppedLogs[index].collected = true; 
                p.bag.push('log'); socket.emit('inventorySync', {bag: p.bag});
            }
        } else if (data.type === 'sapling' || data.type === 'bed_item') {
            const isSapling = data.type === 'sapling';
            const arr = isSapling ? lobby.world.droppedSaplings : lobby.world.droppedBeds;
            const index = arr.findIndex(s => s.id === data.id && !s.collected);
            if (index !== -1) {
                if (data.toBag && p.bag.length < 10) {
                    arr[index].collected = true; 
                    p.bag.push(isSapling ? 'sapling' : 'bed'); socket.emit('inventorySync', {bag: p.bag});
                } else if (!data.toBag) {
                    arr[index].collected = true; 
                    socket.emit('itemToSlot', isSapling ? 'sapling' : 'bed');
                }
            }
        } else if (data.type === 'placedbed') {
            const index = lobby.world.beds.findIndex(b => b.id === data.id);
            if(index !== -1) {
                lobby.world.beds.splice(index, 1);
                if (data.toBag && p.bag.length < 10) {
                    p.bag.push('bed'); socket.emit('inventorySync', {bag: p.bag});
                } else {
                    socket.emit('itemToSlot', 'bed');
                }
            }
        }
    });

    socket.on('dropItem', (data) => {
        if (!currentLobby || !lobbies[currentLobby]) return;
        const lobby = lobbies[currentLobby];
        const p = lobby.players.find(pl => pl.id === socket.id);
        if (!p || p.hp <= 0) return;

        let dist = 1.0;
        if (data.fromBag && p.bag.length > 0) {
            let item = p.bag.pop();
            socket.emit('inventorySync', {bag: p.bag});
            lobby.world.uidCounter++;
            let dObj = { id: 'item_' + lobby.world.uidCounter, x: p.x - Math.sin(p.ry)*dist, y: 1.5, z: p.z - Math.cos(p.ry)*dist, collected: false };
            if(item === 'log') lobby.world.droppedLogs.push(dObj); 
            else if (item === 'sapling') lobby.world.droppedSaplings.push(dObj);
            else if (item === 'bed') lobby.world.droppedBeds.push(dObj);
        } else if (!data.fromBag) {
            lobby.world.uidCounter++;
            let dObj = { id: 'item_' + lobby.world.uidCounter, x: p.x - Math.sin(p.ry)*dist, y: 1.5, z: p.z - Math.cos(p.ry)*dist, collected: false };
            if(data.type === 'sapling') lobby.world.droppedSaplings.push(dObj);
            else if(data.type === 'bed') lobby.world.droppedBeds.push(dObj);
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
            if (lobby.players.length === 0) {
                delete lobbies[currentLobby]; 
            } else { 
                io.to(lobby.id).emit('lobbyUpdated', lobby); 
                if (lobby.admin === s.id) lobby.admin = lobby.players[0].id; 
            }
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
        
        // Переход с ночи на утро (ДОБАВЛЯЕТСЯ 2 ДНЯ ЕСЛИ СТОИТ КРОВАТЬ)
        if (lobby.world.timeProgress >= DAY_NIGHT_DURATION) { 
            lobby.world.timeProgress -= DAY_NIGHT_DURATION; 
            if(lobby.world.beds.length > 0) {
                lobby.world.day += 2;
            } else {
                lobby.world.day += 1; 
            }
        }

        // Пассивный реген ХП (5 хп каждые 5 сек)
        if (now - lobby.world.lastRegenTime >= 5000) {
            lobby.players.forEach(p => {
                if (p.hp > 0 && p.hp < 100) {
                    p.hp = Math.min(100, p.hp + 5);
                    io.to(p.id).emit('playerDamaged', p.hp); // Обновляем ХП безопасно
                }
            });
            lobby.world.lastRegenTime = now;
        }

        let cf = lobby.world.campfire;
        let cfRadius = cf.hp > 0 ? 15 + cf.level * 6 : 0; 
        
        if (cf.hp > 0) { cf.hp -= (dt / 1000) * (1 / (cf.level * 0.5)); if (cf.hp < 0) cf.hp = 0; }

        lobby.world.droppedLogs.forEach(log => {
            if (log.y > 0.2) log.y -= 0.15; else log.y = 0.2;
            if (!log.collected) {
                // Проверка Костра
                let dxC = log.x - cf.x; let dzC = log.z - cf.z;
                if (Math.sqrt(dxC*dxC + dzC*dzC) < 1.8 && log.y < 0.8) {
                    log.collected = true; 
                    let gain = Math.max(2, 20 - (cf.level * 3)); 
                    cf.hp += gain;
                    if (cf.hp >= 100 && cf.level < 10) { cf.level++; cf.hp -= 100; if(cf.hp===0) cf.hp=1; } else if (cf.hp > 100) cf.hp = 100;
                }
                
                // Проверка Переработчика верстака (recycler)
                let dxR = log.x - lobby.world.recycler.x; let dzR = log.z - lobby.world.recycler.z;
                if (!log.collected && Math.sqrt(dxR*dxR + dzR*dzR) < 1.5 && log.y < 0.8) {
                    log.collected = true;
                    lobby.world.workbench.wood += 1;
                }
            }
        });
        lobby.world.droppedLogs = lobby.world.droppedLogs.filter(l => !l.collected);
        
        lobby.world.droppedSaplings.forEach(sap => { if (sap.y > 0.2) sap.y -= 0.15; else sap.y = 0.2; });
        lobby.world.droppedSaplings = lobby.world.droppedSaplings.filter(s => !s.collected);
        
        lobby.world.droppedBeds.forEach(bed => { if (bed.y > 0.2) bed.y -= 0.15; else bed.y = 0.2; });
        lobby.world.droppedBeds = lobby.world.droppedBeds.filter(b => !b.collected);

        for (let i = lobby.world.saplings.length - 1; i >= 0; i--) {
            let s = lobby.world.saplings[i]; s.timer += dt;
            if (s.stage === 0 && s.timer > 5000) s.stage = 1;
            else if (s.stage === 1 && s.timer > 95000) s.stage = 2; 
            else if (s.stage === 2 && s.timer > 185000) { 
                lobby.world.uidCounter++; const newTree = { id: 'tree_' + lobby.world.uidCounter, x: s.x, z: s.z, hp: 4, isCut: false, sinkY: 0 };
                lobby.world.trees.push(newTree); io.to(lobbyId).emit('treeUpdated', newTree);
                lobby.players.forEach(p => { let d = Math.sqrt(Math.pow(p.x - s.x, 2) + Math.pow(p.z - s.z, 2)); if(d < 1.0) { p.x += 1.5; p.z += 1.5; io.to(p.id).emit('forceMove', {x: p.x, z: p.z}); } });
                lobby.world.saplings.splice(i, 1);
            }
        }

        if(lobby.world.isNight && !wasNight) {
            let spawnCount = 2 + cf.level;
            for(let i=0; i<spawnCount; i++) {
                lobby.world.uidCounter++; let angle = Math.random() * Math.PI * 2;
                lobby.world.wolves.push({ id: 'wolf_' + lobby.world.uidCounter, x: Math.cos(angle) * 40, z: Math.sin(angle) * 40, ry: 0, hp: 100, lastAttack: 0 });
            }
        } else if(!lobby.world.isNight && wasNight) { lobby.world.wolves = []; }

        lobby.world.wolves.forEach((w, index) => {
            lobby.world.wolves.forEach((otherW, jIndex) => {
                if (index !== jIndex) {
                    let ddx = w.x - otherW.x; let ddz = w.z - otherW.z; let ddist = Math.sqrt(ddx*ddx + ddz*ddz);
                    if (ddist > 0.01 && ddist < 0.8) {
                        w.x += (ddx/ddist) * 1.5 * (dt/1000); w.z += (ddz/ddist) * 1.5 * (dt/1000);
                    }
                }
            });

            let closestP = null; let minD = 999;
            lobby.players.forEach(p => {
                if(p.hp > 0) { let d = Math.sqrt(Math.pow(p.x - w.x, 2) + Math.pow(p.z - w.z, 2)); if(d < minD) { minD = d; closestP = p; } }
            });

            if(closestP) {
                let dToFireP = Math.sqrt(Math.pow(closestP.x - cf.x, 2) + Math.pow(closestP.z - cf.z, 2));
                let dToFireW = Math.sqrt(Math.pow(w.x - cf.x, 2) + Math.pow(w.z - cf.z, 2));

                if (cf.hp > 0 && dToFireW < cfRadius) {
                    let dx = w.x - cf.x; let dz = w.z - cf.z; let len = Math.sqrt(dx*dx + dz*dz);
                    w.x += (dx/len) * 4.0 * (dt/1000); w.z += (dz/len) * 4.0 * (dt/1000); w.ry = Math.atan2(dx, dz);
                } else if(cf.hp > 0 && dToFireP < cfRadius) {
                    let dx = closestP.x - w.x; let dz = closestP.z - w.z; w.ry = Math.atan2(dx, dz);
                } else {
                    let dx = closestP.x - w.x; let dz = closestP.z - w.z;
                    if(minD > 1.2) {
                        w.x += (dx/minD) * 3.5 * (dt/1000); w.z += (dz/minD) * 3.5 * (dt/1000); w.ry = Math.atan2(dx, dz);
                    } else {
                        if (now - w.lastAttack > 3000) {
                            w.lastAttack = now; closestP.hp -= 15;
                            if(closestP.hp <= 0) { closestP.hp = 0; io.to(lobbyId).emit('chatMessage', `🐺 Волки растерзали ${closestP.name}`); }
                            io.to(closestP.id).emit('playerDamaged', closestP.hp);
                        }
                    }
                }
            }
        });

        io.to(lobbyId).emit('worldSync', {
            day: lobby.world.day, isNight: lobby.world.isNight, timeProgress: lobby.world.timeProgress,
            campfire: { hp: Number(lobby.world.campfire.hp.toFixed(1)), level: lobby.world.campfire.level, x:0, z:0 },
            workbench: lobby.world.workbench,
            beds: lobby.world.beds,
            droppedLogs: lobby.world.droppedLogs.map(l => ({ id: l.id, x: Number(l.x.toFixed(2)), y: Number(l.y.toFixed(2)), z: Number(l.z.toFixed(2)) })),
            droppedSaplings: lobby.world.droppedSaplings.map(s => ({ id: s.id, x: Number(s.x.toFixed(2)), y: Number(s.y.toFixed(2)), z: Number(s.z.toFixed(2)) })),
            droppedBeds: lobby.world.droppedBeds.map(b => ({ id: b.id, x: Number(b.x.toFixed(2)), y: Number(b.y.toFixed(2)), z: Number(b.z.toFixed(2)) })),
            saplings: lobby.world.saplings.map(s => ({ id: s.id, x: Number(s.x.toFixed(2)), z: Number(s.z.toFixed(2)), stage: s.stage })),
            wolves: lobby.world.wolves.map(w => ({ id: w.id, x: Number(w.x.toFixed(2)), z: Number(w.z.toFixed(2)), ry: Number(w.ry.toFixed(2)), hp: w.hp }))
        });
        io.to(lobbyId).emit('playersSync', lobby.players.map(p => ({ id: p.id, name: p.name, color: p.color, hp: p.hp, x: Number(p.x.toFixed(2)), z: Number(p.z.toFixed(2)), ry: Number(p.ry.toFixed(2)) })));

    }, 200); 
}

function getLobbiesList() { return Object.values(lobbies).filter(l => !l.isPlaying).map(l => ({ id: l.id, name: l.name, hasPassword: !!l.password, playersCount: l.players.length, maxPlayers: l.maxPlayers })); }
const PORT = process.env.PORT || 3000; server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
