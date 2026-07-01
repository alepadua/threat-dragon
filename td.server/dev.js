var appFactory = require('./src/app.js');

var app = appFactory.default.create();

var server = app.listen(app.get('port'), function() {
    var addr = server.address();
    if (addr) {
        console.log('Development server listening at ' + addr.address + ' on port ' + addr.port);
    } else {
        console.log('Development server listening on port ' + app.get('port'));
    }
});

process.once('SIGUSR2', 
  function () { 
    process.kill(process.pid, 'SIGUSR2'); 
  }
);
