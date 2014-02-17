/**
 * Module dependencies.
 */

var 
	mongoose = require('mongoose'),
	env = process.env.NODE_ENV || 'development',
	config = require('../../config/config')[env],
	Schema = mongoose.Schema,
	csv = require('csv'),
	_ = require('underscore'),
	request = require('request-json'),
	client = request.newClient(config.osrmUrl),
	async = require('async'),
	geolib = require('geolib'),
	moment = require('moment');


/**
 * City Schema
 */

var CitySchema = new Schema({
  _id: {type: String},
  name: {type : String, default : '', trim : true, required: true},
  state: {type: String},  
  isCapital: {type: Boolean, defaut: false},
  nearCities: [{
    city: { type: String, ref: 'City'},
    straightDistance: {type: Number, default: 0},
    routeForwardDistanceRatio: {txype: Number, default: 0},
    routeBackwardDistanceRatio: {type: Number, default: 0}
  }],
  stats: {
    // percentualConnected: { type: Number, default: 0},    
    totalConnected: { type: Number, default: 0},
    totalTortuous: { type: Number, default: 0},
    totalInexistent: { type: Number, default: 0},        
    totalChecked: { type: Number, default: 0}
  },
  loc: { type: {type: String}, coordinates: []},
  updatedAt: {type: Date},
  shouldUpdate: {type: Boolean, default: true},
  isUpdating: {type: Boolean, default: false}
})

/**
 * Geo index
 **/

CitySchema.index({ loc: '2dsphere' })

/**
 * Virtuals
 **/


CitySchema.virtual('fullname').get(function () {
  return this.name + ' (' + this.state+')';
});

/**
 * Methods
 */

CitySchema.methods = {
	
	findNearest: function(limit, callback){
		var 
			City = mongoose.model('City'),
			nearest = [];

		this.model('City').collection
			.geoNear(this.getLon(), this.getLat(), {spherical: true, num: limit + 1, distanceMultiplier: 6371}, function(err, cities){
			if (err) callback(err);

			// remove first element
			cities.results.shift()

			async.map(cities.results, function(city,cb){
				nearest.push({
					distance: parseFloat(city.dis.toFixed(1)),
					city: city.obj._id
				});
				cb();
			},function(err){
				callback(err,nearest);
			});
		});
	},
	
	generateRouteRequests: function(){
		
		var 
			self = this,
			RouteRequest = mongoose.model('Request'),
			Log = mongoose.model('Log');
		
		if (self.nearCities.length == 0) {
			self.findNearest(5, function(err, near){
				self.nearCities = near;
				self.generateRouteRequests();
			});
		} else {
			_.each(self.nearCities, function(target){
				var
					fowardRouteRequest,
					backwardRouteRequest;
					
				async.parallel([
					function(cb){
						var fowardRouteRequest = new RouteRequest({
							from: self._id,
							to: target.city
						}).save(cb);
					},
					function(cb){
						var backwardRouteRequest = new RouteRequest({
							to: self._id,
							from: target.city
						}).save(cb);
					}
				], function(err){
					
					var log;
					
					if (err) {
						log = new Log({
							status: 'error', 
							context: 'request generation', 
							data: {
								errors: err
							}
						});
					} else {
						log = new Log({
							status: 'info', 
							context: 'request generation', 
							data: {
								errors: err
							}
						});
					}

					log.affectedCities.addToSet([self._id, target._id]);
					log.save();
				})
			});
		}
	},
	
	getLogs: function(options, callback) {
		mongoose.model('Log').find({city: Schema.ObjectId(this._id)}, callback);
	},

  needsUpdate: function(){
    this.shouldUpdate = true
    this.save()
  },
  getLon: function(){
    return this.loc.coordinates[0]
  },
  getLat: function(){
    return this.loc.coordinates[1]    
  },
  getPercentualConnected: function(){
    return (this.stats.totalConnected / this.stats.totalChecked * 100 | 0)
  },
  getPercentualTortuous: function(){
    return this.stats.totalTortuous / this.stats.totalChecked * 100
  },
  getPercentualInexistent: function(){
    return this.stats.totalInexistent / this.stats.totalChecked * 100
  },    
  getStraightDistanceTo: function(city){
    return geolib.getDistance({
      latitude: this.getLon(), 
      longitude: this.getLat()
    }, {
      latitude: 
      city.getLon(), 
      longitude: this.getLat()
    })
  },
  getViewInOSRMLink: function(city_to){
    return "http://map.project-osrm.org/?loc="+this.getLat()+","+this.getLon()
      +"&loc="+city_to.loc.coordinates[1]+","+city_to.loc.coordinates[0]
      +"&output=json"
      +"&z=0"
      +"&hl=pt"
  },
  routeTo: function(city_to, callback){
    var self = this
      , query_str = "viaroute?loc="+this.getLat()+","+this.getLon()
        +"&loc="+city_to.getLat()+","+city_to.getLon()
        +"&output=json"
        +"&z=0"        

    client.get(query_str, function(error, response, body) {
      if (error) callback(error)
      callback(null, body)
    })
  },
  checkConnectionTo: function(targetCity, straightDistance, doneCheckConnectionTo){
    var self = this

   // fetch foward route
    self.routeTo(targetCity, function(err, routeAB){
      if (err) doneCheckConnectionTo(err)

      // fetch backward route
      targetCity.routeTo(self, function(err, routeBA){
        if (err) doneCheckConnectionTo(err)
        
        // get route distances
        routeABDistance = routeAB.route_summary.total_distance / 1000
        routeBADistance = routeBA.route_summary.total_distance / 1000
        
                
        route = {
          id: targetCity,
          straightDistance: straightDistance,
          routeForwardDistanceRatio: routeABDistance > 0 ? (routeABDistance / straightDistance - 1) * 100 : 0,
          routeBackwardDistanceRatio: routeABDistance > 0 ? (routeBADistance / straightDistance - 1) * 100 : 0
        }
        self.nearCities.push(route)
        
        // update connection counter
        if (route.routeForwardDistanceRatio >= 50) {
          self.stats.totalTortuous += 1
        } else if (route.routeForwardDistanceRatio > 0 && route.routeForwardDistanceRatio < 50) 
          self.stats.totalConnected += 1
        else {  
          self.stats.totalInexistent += 1          
        }
        
        // update connection counter
        if (route.routeBackwardDistanceRatio >= 50) {
          self.stats.totalTortuous += 1
        } else if (route.routeBackwardDistanceRatio > 0 && route.routeBackwardDistanceRatio < 50) {
          self.stats.totalConnected += 1
        } else {  
          self.stats.totalInexistent += 1          
        }
        
        self.stats.totalChecked += 2

        doneCheckConnectionTo()
      })
    })
  },
  updateConnections: function(cities_qty){
    var self = this
    
    // flag as a updating city and save
    self.isUpdating = true

    // clear prior information
    self.nearCities = []
    self.stats.totalConnected = 0
    self.stats.totalTortuous = 0        
    self.stats.totalInexistent = 0
    self.stats.totalChecked = 0    
    self.save(function(err){
      if (err) {
        console.log(err)
      } else {
        // find nearest cities
        self.findNearest(cities_qty, function(err,nearCities){
          // check routes
          async.eachSeries(nearCities, function(nearCity, doneCheckingAConnection){
              self.checkConnectionTo(nearCity.obj,nearCity.dis,doneCheckingAConnection)
            }, function(err){
              if (err) console.log(err)
              
              // update start and save
              self.stats.percentualConnected = self.stats.totalConnected / self.stats.totalChecked || 0
              self.isUpdating = false
              self.shouldUpdate = false
              self.updatedAt = Date.now()
              self.save()
          })
        })
      }      
    })
  },
  getConnectivity: function(){
    return (this.stats.percentualConnected || 0)
  },
  getColor: function(){
    var percentColors = [
        { pct: 0, color: { r: 0xff, g: 0x00, b: 0 } },
        { pct: 0.5, color: { r: 0xff, g: 0xff, b: 0 } },
        { pct: 1.0, color: { r: 0x00, g: 0xff, b: 0 } } ];

    var getColorForPercentage = function(pct) {
        for (var i = 0; i < percentColors.length; i++) {
          if (pct == 0) {
              return 'rgb(255, 0, 0)'            
          } else if (pct <= percentColors[i].pct) {
              var lower = percentColors[i - 1];
              var upper = percentColors[i];
              var range = upper.pct - lower.pct;
              var rangePct = (pct - lower.pct) / range;
              var pctLower = 1 - rangePct;
              var pctUpper = rangePct;
              var color = {
                  r: Math.floor(lower.color.r * pctLower + upper.color.r * pctUpper),
                  g: Math.floor(lower.color.g * pctLower + upper.color.g * pctUpper),
                  b: Math.floor(lower.color.b * pctLower + upper.color.b * pctUpper)
              };
              return 'rgb(' + [color.r, color.g, color.b].join(',') + ')';
              // or output as hex if preferred
          }
        }
    }
    console.log(this.getPercentualConnected()/100)
    return getColorForPercentage(this.getPercentualConnected()/100)
  }

}

/**
 * Statics
 */

CitySchema.statics = {

	updateACity: function() {

		var
			expirationTime = moment().subtract('day', 1).toDate();
				
		// Find the city most in need of a update. 
		this
			.findOne({
				$and: [ 
					{ 
						$or: [
							{needsUpdate: true}, 
							{updatedAt: {$lt: expirationTime}}
						]
					},
						{
							isUpdating: false
						}
					]
				
				})
			.limit(1)
			.exec(function(err, city){
				city.generateRouteRequests();
			})
	},

  load: function (id, doneLoading) {
    this
      .findById(id)
      .exec(doneLoading)      
  },
  list: function (options, cb) {
    var criteria = options.criteria || {}
    this.find(options.criteria)
      .sort(options.sortBy || {'updatedAt': -1})
      // .select(options.select)
      .limit(options.perPage)
      .skip(options.perPage * options.page)
      .exec(cb)
  },
  importFromCSV: function(filename, callback) {
    var self = this
      , City = mongoose.model('City')
    csv()
    .from.path(__dirname+filename, { columns: true, delimiter: ',', escape: '"' })
	.to.array(function(data){
		City.remove(function(err){
			async.each(data, function(item,cb){
				city = new City({_id: item.ibge_id})
				city.name = item.name
				city.state = item.uf
				city.isCapital = item.capital
				city.loc = {type: 'Point', coordinates: [new Number(item.lon),new Number(item.lat)]}
				console.log(item);
				city.save(function(err){
					console.log(err);
					cb(err);
				});
			}, callback);
		})
    });
  }
}


mongoose.model('City', CitySchema)